import { createHash } from 'node:crypto';
import * as path from 'node:path';
import type { Configuration } from '@agent-observability/core/src/config/configuration';
import type { SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import type { CancellationToken } from '@agent-observability/core/src/chat/backends/cancellation';
import type { ChatBackend } from '@agent-observability/core/src/chat/backends/chatBackend';
import { CliBackendError } from '@agent-observability/core/src/chat/backends/cliError';
import {
  IMPROVE_LIMITS,
  buildContextImprovementPrompt,
  parseContextPlan,
  type ImproveHotspotStat,
  type ImproveSessionEvidence,
} from '@agent-observability/core/src/chat/tasks/contextImprovement';
import { gatherProjectContextFiles } from '@agent-observability/core/src/chat/tasks/projectContext';
import { buildRepoCustomizationIndex } from '@agent-observability/core/src/aggregate/customizationFilter';
import { markdownToHtml } from '@agent-observability/core/src/chat/webview/markdownToHtml';
import type {
  ContextPlanSummary,
  ContextPlanView,
  ImproveGenerateParams,
  ImproveGenerateResult,
  ImproveRepoStatus,
} from '../../shared/rpc';
import { MAX_IMPROVE_HOTSPOTS, MAX_IMPROVE_SESSIONS } from '../../shared/rpc';
import { retrospectiveFor } from '../analysis/sessionRetrospective';
import { timeoutToken } from '../cancellation';
import type { IndexDb } from '../indexer/indexDb';
import type { DesktopSettingsReader } from '../drivers/desktopConfig';
import type { DeepRetroStore } from '../deepRetros';
import { resolveRepoRoot, type RepoRootSeams } from './repoRoot';
import type { ContextPlanStore, StoredContextPlan, StoredPlanEdit } from './contextPlans';

/**
 * The Context Improvement Plan runner — THE THIRD SANCTIONED EXCEPTION to the
 * privacy invariant (AGENTS.md lists all three), shaped like `deepRetro.ts`.
 *
 * Consent is enforced in depth: the renderer shows a per-generation dialog
 * naming the vendor and the payload before calling `improve.generate`, and
 * this module INDEPENDENTLY refuses when the settings toggle is off — no
 * renderer bug can turn an unconsented call into a network transmission. The
 * spawn is the user's own AI CLI through the shared backend registry.
 *
 * Absolute paths never enter the prompt: hotspot identities are mapped
 * repo-relative (or reduced to their short name) before the prompt is built.
 */

/** Settings key for the opt-in gate. Desktop-only; not a core ConfigKey. */
export const IMPROVE_ENABLED_KEY = 'improve.enabled';

/** Bigger prompt and answer than a deep retro — give it twice the ceiling. */
const IMPROVE_TIMEOUT_MS = 240_000;

export interface ContextPlanDeps {
  db: IndexDb;
  sources: SourceRegistry;
  store: ContextPlanStore;
  deepRetros: DeepRetroStore;
  config: Configuration;
  settings: DesktopSettingsReader;
  backend: ChatBackend;
  vendor: string;
  /** Injectable seams so tests use fixture repos and never spawn a CLI. */
  rootSeams?: RepoRootSeams;
  gather?: typeof gatherProjectContextFiles;
  runPrompt?: (prompt: string, token: CancellationToken) => Promise<string>;
}

/** In-flight generations by repository: a double-click must not start two spawns. */
const inFlight = new Map<string, Promise<ImproveGenerateResult>>();

export function generateContextPlan(
  params: ImproveGenerateParams,
  deps: ContextPlanDeps,
): Promise<ImproveGenerateResult> {
  const running = inFlight.get(params.repository);
  if (running !== undefined) {
    return running;
  }
  const run = execute(params, deps).finally(() => inFlight.delete(params.repository));
  inFlight.set(params.repository, run);
  return run;
}

/** Whether a repository can generate plans right now, for the view's banner. */
export function improveRepoStatus(
  repository: string,
  db: IndexDb,
  seams: RepoRootSeams = {},
): ImproveRepoStatus {
  if (repository.length === 0) {
    return { repository, error: 'Pick a repository first.' };
  }
  const resolved = resolveRepoRoot(repository, db, seams);
  if ('error' in resolved) {
    return { repository, error: resolved.error };
  }
  const index = buildRepoCustomizationIndex(resolved.root);
  const contextFileCount = new Set([...index.byKey.values()].flat()).size;
  return { repository, root: resolved.root, contextFileCount };
}

async function execute(
  params: ImproveGenerateParams,
  deps: ContextPlanDeps,
): Promise<ImproveGenerateResult> {
  if (deps.settings.get<boolean>(IMPROVE_ENABLED_KEY, false) !== true) {
    return { error: 'Context improvement plans are turned off in Settings.' };
  }
  const hotspotFiles = params.hotspotFiles.slice(0, MAX_IMPROVE_HOTSPOTS);
  const sessionRefs = params.sessions.slice(0, MAX_IMPROVE_SESSIONS);
  if (hotspotFiles.length === 0 && sessionRefs.length === 0) {
    return { error: 'Select at least one context file or session first.' };
  }

  // Every selected session must belong to the plan's repository — the UI
  // prevents a cross-repo selection, and this refuses one anyway.
  for (const ref of sessionRefs) {
    const row = deps.db.getRow(ref.source, ref.sessionId);
    if (row === undefined) {
      return { error: 'A selected session is no longer in the index. Reselect and try again.' };
    }
    if (row.repository !== params.repository) {
      return { error: 'Selected sessions must all belong to the chosen repository.' };
    }
  }

  const resolved = resolveRepoRoot(params.repository, deps.db, deps.rootSeams ?? {});
  if ('error' in resolved) {
    return { error: resolved.error };
  }
  const root = resolved.root;

  const hotspots = buildHotspotStats(params.repository, hotspotFiles, root, deps.db);
  const sessions = buildSessionEvidence(sessionRefs, deps);
  const gathered = (deps.gather ?? gatherProjectContextFiles)(root);
  const prompt = buildContextImprovementPrompt(params.repository, hotspots, sessions, gathered);

  const timeout = timeoutToken(IMPROVE_TIMEOUT_MS);
  try {
    const reply = await (deps.runPrompt ?? cliRunner(deps.backend))(prompt, timeout.token);
    const parsed = parseContextPlan(reply, gathered);

    const hashes = new Map(gathered.map((file) => [file.path, sha256(file.content)]));
    const edits: StoredPlanEdit[] = parsed.edits.map((edit) => ({
      ...edit,
      ...(edit.action === 'replace' ? { baseHash: hashes.get(edit.path) } : {}),
    }));
    const plan: StoredContextPlan = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      repository: params.repository,
      repoRoot: root,
      createdAtMs: Date.now(),
      backendId: deps.backend.id,
      backendLabel: deps.backend.label,
      vendor: deps.vendor,
      model: modelFor(deps),
      selection: {
        hotspotFiles,
        sessions: sessionRefs.map((ref) => ({
          ...ref,
          ...(deps.db.getRow(ref.source, ref.sessionId)?.title !== undefined
            ? { title: deps.db.getRow(ref.source, ref.sessionId)?.title }
            : {}),
        })),
      },
      narrative: parsed.narrative,
      ...(parsed.summary !== undefined ? { summary: parsed.summary } : {}),
      invalidEditCount: parsed.invalidEditCount,
      edits,
      gathered: gathered.map((file) => ({
        path: file.path,
        baseHash: hashes.get(file.path) ?? '',
        truncated: file.truncated,
      })),
    };
    deps.store.add(plan);
    return { plan: planView(plan) };
  } catch (err) {
    if (timeout.token.isCancellationRequested) {
      return { error: 'The improvement plan timed out. Try fewer files and sessions.' };
    }
    if (err instanceof CliBackendError) {
      return { error: deps.backend.describeError(err).message };
    }
    return { error: err instanceof Error ? err.message : String(err) };
  } finally {
    timeout.dispose();
  }
}

/** Render one stored plan for the view. Edit CONTENT stays datahost-side. */
export function planView(plan: StoredContextPlan): ContextPlanView {
  return {
    id: plan.id,
    repository: plan.repository,
    createdAtMs: plan.createdAtMs,
    backendLabel: plan.backendLabel,
    vendor: plan.vendor,
    model: plan.model,
    narrativeHtml: markdownToHtml(plan.narrative),
    ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
    invalidEditCount: plan.invalidEditCount,
    edits: plan.edits.map((edit) => ({
      path: edit.path,
      action: edit.action,
      ...(edit.rationale !== undefined ? { rationale: edit.rationale } : {}),
      ...(edit.appliedAtMs !== undefined ? { appliedAtMs: edit.appliedAtMs } : {}),
      ...(edit.revertedAtMs !== undefined ? { revertedAtMs: edit.revertedAtMs } : {}),
      canUndo:
        edit.appliedAtMs !== undefined &&
        edit.revertedAtMs === undefined &&
        edit.backup !== undefined,
    })),
  };
}

/** One history row per stored plan. */
export function planSummary(plan: StoredContextPlan): ContextPlanSummary {
  return {
    id: plan.id,
    repository: plan.repository,
    createdAtMs: plan.createdAtMs,
    backendLabel: plan.backendLabel,
    ...(plan.summary !== undefined ? { summary: plan.summary } : {}),
    editCount: plan.edits.length,
    appliedCount: plan.edits.filter(
      (edit) => edit.appliedAtMs !== undefined && edit.revertedAtMs === undefined,
    ).length,
  };
}

/** sha256 of a UTF-8 string — the staleness fingerprint used at apply time too. */
export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The selected hotspot rows as prompt-safe statistics: repo-relative paths
 * (or short names) only — the absolute identity never enters the prompt.
 */
function buildHotspotStats(
  repository: string,
  hotspotFiles: readonly string[],
  root: string,
  db: IndexDb,
): ImproveHotspotStat[] {
  const rows = db.hotspots({ repository });
  const wanted = new Set(hotspotFiles);
  return rows
    .filter((row) => wanted.has(row.file))
    .map((row) => ({
      path: promptSafePath(row.file, root),
      category: row.category,
      sessionCount: row.sessionCount,
      appliedCount: row.appliedCount,
      skippedCount: row.skippedCount,
      readCount: row.readCount,
      estTokensMax: row.estTokensMax,
      errorSessions: row.errorSessions,
      deviationSessions: row.deviationSessions,
    }))
    .slice(0, IMPROVE_LIMITS.maxHotspots);
}

/** Repo-relative POSIX path under the root; anything else collapses to its name. */
/**
 * A context file's identity without its absolute path: repo-relative POSIX
 * under `root`, else the bare file name. Shared with the Workspace digest so
 * no feature builds a second, slightly different rule.
 */
export function promptSafePath(file: string, root: string): string {
  if (!path.isAbsolute(file)) {
    return file.replace(/\\/g, '/');
  }
  const rel = path.relative(root, file);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    return path.basename(file);
  }
  return rel.replace(/\\/g, '/');
}

/** The selected sessions' retrospective evidence, recomputed like the detail card's. */
function buildSessionEvidence(
  refs: readonly { source: string; sessionId: string }[],
  deps: ContextPlanDeps,
): ImproveSessionEvidence[] {
  const out: ImproveSessionEvidence[] = [];
  for (const ref of refs) {
    const dataSource = deps.sources.get(ref.source);
    if (dataSource === undefined) {
      continue;
    }
    const detail = dataSource.getSessionDetail(ref.sessionId);
    if (!detail.ok) {
      continue; // a session that can no longer be read degrades to absent evidence
    }
    let retro;
    try {
      retro = retrospectiveFor(dataSource, ref.sessionId, detail.value);
    } catch {
      continue;
    }
    const title = deps.db.getRow(ref.source, ref.sessionId)?.title;
    const deep = deps.deepRetros.get(ref.source, ref.sessionId);
    out.push({
      ...(title !== undefined ? { title } : {}),
      ...(retro.goal !== undefined ? { goal: retro.goal } : {}),
      verdict: retro.verdict,
      outcome: retro.outcome,
      findings: retro.findings.map((finding) => ({
        id: finding.id,
        severity: finding.severity,
        description: finding.description,
      })),
      tips: retro.tips.map((tip) => tip.text),
      ...(deep?.narrative !== undefined ? { deepNarrative: deep.narrative } : {}),
    });
  }
  return out;
}

/** The model name recorded on the plan — whichever the active backend uses. */
function modelFor(deps: ContextPlanDeps): string {
  return deps.backend.id === 'copilot-cli'
    ? deps.config.getAiHelperCopilotCliModel()
    : deps.config.getAiHelperClaudeModel();
}

/** Collect one full CLI reply through the shared chat backend. */
function cliRunner(backend: ChatBackend): (prompt: string, token: CancellationToken) => Promise<string> {
  return async (prompt, token) => {
    const availability = await backend.isAvailable();
    if (!availability.available) {
      throw new Error(availability.reason);
    }
    let collected = '';
    await backend.streamChat(
      { messages: [{ role: 'user', text: prompt }] },
      (delta) => {
        collected += delta;
      },
      token,
    );
    return collected;
  };
}
