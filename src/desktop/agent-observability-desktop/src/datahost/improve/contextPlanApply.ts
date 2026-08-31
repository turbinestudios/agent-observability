import * as fs from 'node:fs';
import * as path from 'node:path';
import { isSafeContextFilePath } from '@agent-observability/core/src/aggregate/customizationFilter';
import { resolveWorkspaceRepository } from '@agent-observability/core/src/chat/tasks/projectContext';
import { diffLines, foldContext } from '@agent-observability/core/src/text/lineDiff';
import type { ApplyFileResult, ApplyResult, FileDiffLine, FileDiffResult } from '../../shared/rpc';
import type { DesktopSettingsReader } from '../drivers/desktopConfig';
import { IMPROVE_ENABLED_KEY, sha256 } from './contextPlan';
import type { ContextPlanStore, StoredContextPlan, StoredPlanEdit } from './contextPlans';

/**
 * The product's ONE sanctioned write path into user repositories — applying a
 * Context Improvement Plan's approved edits. Everything here is enforced
 * datahost-side, independent of the renderer, in this order:
 *
 * 1. The `improve.enabled` gate (the same one generation honors).
 * 2. The target must be one of the plan's stored, already-validated edits, and
 *    its path is re-checked against the customization allowlist anyway — the
 *    store file is user-editable JSON, so nothing in it is trusted twice.
 * 3. The plan's recorded root must still exist and still resolve to the SAME
 *    repository (a moved checkout or re-pointed remote refuses, never writes),
 *    and the joined path must stay inside it.
 * 4. `replace` refuses when the file changed since generation (hash mismatch)
 *    or vanished; `create` refuses when the file now exists.
 * 5. The pre-apply backup is persisted to the plan store BEFORE the repo file
 *    is touched, so undo data survives a crash mid-apply. Writes are atomic
 *    (temp + rename).
 * 6. Nothing is ever deleted: there is no delete action anywhere in the
 *    contract, and undoing a `create` reports rather than removes.
 */

/** Injectable seams so tests run against temp fixture repos. */
export interface ApplySeams {
  resolveRepository?: (root: string) => string;
}

export interface ApplyDeps {
  store: ContextPlanStore;
  settings: DesktopSettingsReader;
  seams?: ApplySeams;
}

/**
 * Diff one proposed edit against the file as it stands RIGHT NOW — the preview
 * doubles as a live staleness probe, so what the user approves is what the
 * apply will actually verify.
 */
export function diffForEdit(planId: string, relPath: string, deps: ApplyDeps): FileDiffResult {
  const found = locate(planId, relPath, deps);
  if ('error' in found) {
    return { lines: [], stale: false, missing: false, error: found.error };
  }
  const { edit, abs } = found;

  let current = '';
  let missing = false;
  try {
    current = fs.readFileSync(abs, 'utf8');
  } catch {
    missing = true;
  }
  const stale =
    edit.action === 'replace'
      ? missing || (edit.baseHash !== undefined && sha256(current) !== edit.baseHash)
      : !missing; // a `create` is stale exactly when the file now exists

  const lines: FileDiffLine[] = foldContext(diffLines(missing ? '' : current, edit.content)).map(
    (line) =>
      line.kind === 'fold' ? { kind: 'fold' as const, count: line.count } : { kind: line.kind, text: line.text },
  );
  return { lines, stale, missing: edit.action === 'replace' && missing };
}

/** Write the approved edits. Per-file results; one refusal never blocks the rest. */
export function applyContextPlan(planId: string, paths: string[], deps: ApplyDeps): ApplyResult {
  const gate = checkedPlan(planId, deps);
  if ('error' in gate) {
    return { results: [], error: gate.error };
  }
  const { plan } = gate;

  const results: ApplyFileResult[] = [];
  for (const relPath of paths) {
    results.push(applyOne(plan, relPath, deps));
  }
  deps.store.flush();
  return { results };
}

/** Restore applied files from their backups. Refuses after outside edits. */
export function undoContextPlan(planId: string, paths: string[], deps: ApplyDeps): ApplyResult {
  const gate = checkedPlan(planId, deps);
  if ('error' in gate) {
    return { results: [], error: gate.error };
  }
  const { plan } = gate;

  const results: ApplyFileResult[] = [];
  for (const relPath of paths) {
    results.push(undoOne(plan, relPath));
  }
  deps.store.flush();
  return { results };
}

// ---------------------------------------------------------------------------

function applyOne(plan: StoredContextPlan, relPath: string, deps: ApplyDeps): ApplyFileResult {
  const found = locateIn(plan, relPath);
  if ('error' in found) {
    return { path: relPath, ok: false, status: 'refused', detail: found.error };
  }
  const { edit, abs } = found;

  let current: string | undefined;
  try {
    current = fs.readFileSync(abs, 'utf8');
  } catch {
    current = undefined;
  }

  if (edit.action === 'replace') {
    if (current === undefined) {
      return {
        path: relPath,
        ok: false,
        status: 'missing',
        detail: 'The file no longer exists — regenerate the plan.',
      };
    }
    if (edit.baseHash === undefined || sha256(current) !== edit.baseHash) {
      return {
        path: relPath,
        ok: false,
        status: 'stale',
        detail: 'Changed since this plan was generated — regenerate the plan.',
      };
    }
    // Backup FIRST, flushed to disk before the repo file is touched: a crash
    // between the two costs a re-apply, never the way back.
    edit.backup = { content: current, capturedAtMs: Date.now() };
    deps.store.flush();
  } else {
    if (current !== undefined) {
      return {
        path: relPath,
        ok: false,
        status: 'stale',
        detail: 'The file now exists — regenerate the plan to revise it instead.',
      };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
  }

  try {
    atomicWrite(abs, edit.content);
  } catch (err) {
    return {
      path: relPath,
      ok: false,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  edit.appliedAtMs = Date.now();
  delete edit.revertedAtMs;
  return { path: relPath, ok: true, status: 'applied' };
}

function undoOne(plan: StoredContextPlan, relPath: string): ApplyFileResult {
  const found = locateIn(plan, relPath);
  if ('error' in found) {
    return { path: relPath, ok: false, status: 'refused', detail: found.error };
  }
  const { edit, abs } = found;

  if (edit.appliedAtMs === undefined || edit.revertedAtMs !== undefined) {
    return { path: relPath, ok: false, status: 'refused', detail: 'Nothing to undo for this file.' };
  }
  if (edit.backup === undefined) {
    // A created file has no pre-apply state; deleting is not something this
    // path is allowed to do, so the way back is the user's own delete.
    return {
      path: relPath,
      ok: false,
      status: 'refused',
      detail: 'This file was created by the plan — remove it manually if unwanted.',
    };
  }

  let current: string;
  try {
    current = fs.readFileSync(abs, 'utf8');
  } catch {
    return { path: relPath, ok: false, status: 'missing', detail: 'The file no longer exists.' };
  }
  if (sha256(current) !== sha256(edit.content)) {
    return {
      path: relPath,
      ok: false,
      status: 'refused',
      detail: 'Edited since it was applied — undoing now would lose those edits.',
    };
  }

  try {
    atomicWrite(abs, edit.backup.content);
  } catch (err) {
    return {
      path: relPath,
      ok: false,
      status: 'error',
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  edit.revertedAtMs = Date.now();
  return { path: relPath, ok: true, status: 'reverted' };
}

/** Gate + plan + root re-verification shared by apply and undo. */
function checkedPlan(
  planId: string,
  deps: ApplyDeps,
): { plan: StoredContextPlan } | { error: string } {
  if (deps.settings.get<boolean>(IMPROVE_ENABLED_KEY, false) !== true) {
    return { error: 'Context improvement plans are turned off in Settings.' };
  }
  const plan = deps.store.get(planId);
  if (plan === undefined) {
    return { error: 'This plan is no longer stored.' };
  }
  if (!fs.existsSync(plan.repoRoot)) {
    return { error: 'The repository checkout this plan was generated from no longer exists.' };
  }
  const resolve = deps.seams?.resolveRepository ?? resolveWorkspaceRepository;
  if (resolve(plan.repoRoot) !== plan.repository) {
    return {
      error: 'The folder no longer belongs to this repository — nothing was written.',
    };
  }
  return { plan };
}

/** Find an edit in a checked plan and its traversal-guarded absolute path. */
function locateIn(
  plan: StoredContextPlan,
  relPath: string,
): { edit: StoredPlanEdit; abs: string } | { error: string } {
  const edit = plan.edits.find((candidate) => candidate.path === relPath);
  if (edit === undefined) {
    return { error: 'Not one of this plan’s proposals.' };
  }
  // Re-checked even though the parser validated it once: the store is a JSON
  // file the user can edit by hand, and this is the write path.
  if (!isSafeContextFilePath(edit.path)) {
    return { error: 'The path is not an allowlisted context file.' };
  }
  const abs = path.join(plan.repoRoot, edit.path);
  const rel = path.relative(plan.repoRoot, abs);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    return { error: 'The path escapes the repository root.' };
  }
  return { edit, abs };
}

/** Diff lookup shares the gate and location logic with apply. */
function locate(
  planId: string,
  relPath: string,
  deps: ApplyDeps,
): { edit: StoredPlanEdit; abs: string } | { error: string } {
  const gate = checkedPlan(planId, deps);
  if ('error' in gate) {
    return gate;
  }
  return locateIn(gate.plan, relPath);
}

/** Temp-file + rename, the house pattern — a torn write can never half-apply. */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
