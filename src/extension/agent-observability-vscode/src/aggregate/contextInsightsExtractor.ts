/**
 * Context-insights extractor — turns local per-session telemetry into safe,
 * repo-scoped {@link ContextFileObservation}s ready for aggregation.
 *
 * For each session it fuses THREE local signals into context-file entries:
 *  1. Copilot discovery/customization `core_event` spans (when present — the
 *     otlp-http live-updates stream never emits these, so this is a bonus);
 *  2. the customization files Copilot listed as `<file>…</file>` inside the
 *     `gen_ai.system_instructions` blob (the primary applied-file signal); and
 *  3. `read_file` tool calls that targeted customization paths.
 * Each candidate is resolved to a unique repo-relative customization path
 * (dropping anything that is not an in-repo allowlisted file), and the entries
 * are folded into ONE observation per (session, file) carrying the session's
 * friction flags (error / workflow-deviation co-occurrence).
 *
 * Pure + headless: imports only `node:fs`/`node:path` and sibling modules, never
 * `vscode`, so it runs under vitest with plain inputs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseDiscoveryEvents, type DiscoveryEventRow } from '../context/discoveryParser';
import type { AggregationRow } from './aggregator';
import type { ContextInsightCategory } from './contextInsightsModels';
import {
  RepoCustomizationIndex,
  categoryForCustomizationFile,
  resolveRepoRelativePath,
} from './customizationFilter';
import { parseSystemPromptContextFiles } from './systemPromptParser';

/** Approximate characters per token, matching the size estimator's heuristic. */
const CHARS_PER_TOKEN = 4;

/** Closed-set skip-reason category (never raw text). */
export type SkipReasonCategory = 'applyToNoMatch' | 'other';

/** One session's repository + timing + friction flags, derived from safe metadata. */
export interface SessionContext {
  sessionKey: string;
  repository: string;
  startTimeMs: number;
  hadError: boolean;
  hadDeviation: boolean;
}

/** One (session, customization-file) observation — the input grain for aggregation. */
export interface ContextFileObservation {
  startTimeMs: number;
  sessionKey: string;
  repository: string;
  /** Repo-relative POSIX path (already resolved + allowlisted). */
  contextFile: string;
  category: ContextInsightCategory;
  /** True when the file made it into the context window in this session. */
  applied: boolean;
  /** Estimated token weight (0 when skipped). */
  estTokens: number;
  /** Closed-set reason when skipped (undefined when applied). */
  skipReason?: SkipReasonCategory;
  /** The session contained ≥1 errored span. */
  hadError: boolean;
  /** The session was flagged by the local workflow-deviation detector. */
  hadDeviation: boolean;
}

/** A `read_file` tool call that targeted a customization path (LOCAL-ONLY). */
export interface ContextToolRead {
  /** Absolute path from the tool-call arguments; resolved + dropped downstream. */
  filePath: string;
}

/**
 * The LOCAL-ONLY context signals for ONE session, fused by the extractor into
 * per-file observations. All three are read on-machine; only the resolved,
 * repo-relative, allowlisted file paths + counts ever leave via aggregation.
 */
export interface SessionContextSignals {
  /** Discovery/customization `core_event` details (empty on the otlp-http path). */
  discoveryEvents: readonly DiscoveryEventRow[];
  /** `read_file` calls targeting customization paths. */
  toolReads: readonly ContextToolRead[];
  /** Raw `gen_ai.system_instructions` blobs (one per LLM span) for `<file>` parsing. */
  systemInstructions: readonly string[];
}

/** Supplies the LOCAL-ONLY fused context signals for a session. */
export type ContextSignalsProvider = (sessionKey: string) => SessionContextSignals;

/**
 * Fold safe per-span aggregation rows into per-session contexts (repository,
 * earliest start, error flag), marking deviation co-occurrence from an injected
 * set of session keys flagged by the workflow-deviation detector.
 */
export function sessionsFromAggregationRows(
  rows: readonly AggregationRow[],
  deviationSessions: ReadonlySet<string>,
): SessionContext[] {
  const byKey = new Map<string, SessionContext>();
  for (const row of rows) {
    const key = row.sessionKey;
    if (key === undefined || key === null || key.length === 0) {
      continue;
    }
    let session = byKey.get(key);
    if (session === undefined) {
      session = {
        sessionKey: key,
        repository: row.repository,
        startTimeMs: row.startTimeMs,
        hadError: false,
        hadDeviation: deviationSessions.has(key),
      };
      byKey.set(key, session);
    }
    if (row.startTimeMs < session.startTimeMs) {
      session.startTimeMs = row.startTimeMs;
    }
    if (row.statusCode === 2) {
      session.hadError = true;
    }
    if ((session.repository === 'unknown' || session.repository.length === 0) &&
        row.repository !== 'unknown' && row.repository.length > 0) {
      session.repository = row.repository;
    }
  }
  return [...byKey.values()];
}

/** Per-session, per-file fold accumulator. */
interface FileFold {
  category: ContextInsightCategory;
  applied: boolean;
  estTokens: number;
  skipReason?: SkipReasonCategory;
}

/**
 * Extract one {@link ContextFileObservation} per (session, resolved file) by
 * fusing the session's three local context signals. A file is `applied` when it
 * was discovered-and-applied, listed in the system prompt, or read via a tool
 * call; it is `skipped` only when a discovery event says so AND no signal applied
 * it. Files that do not resolve to a unique in-repo customization path are dropped.
 */
export function extractContextObservations(
  sessions: readonly SessionContext[],
  getSignals: ContextSignalsProvider,
  workspaceCwd: string | undefined,
  index: RepoCustomizationIndex,
): ContextFileObservation[] {
  const observations: ContextFileObservation[] = [];

  for (const session of sessions) {
    const signals = getSignals(session.sessionKey);
    const perFile = new Map<string, FileFold>();

    // 1. Discovery/customization events (additive; empty on the otlp-http path).
    for (const entry of parseDiscoveryEvents(signals.discoveryEvents)) {
      // Tool-read entries here are source/doc files — the dedicated tool-read
      // signal below handles customization reads with their absolute path.
      if (entry.status === 'read') {
        continue;
      }
      const rel = resolveRepoRelativePath(entry.name, entry.filePath, workspaceCwd, index);
      if (rel === undefined) {
        continue;
      }
      const category = entry.category === 'unknown' ? categoryForCustomizationFile(rel) : entry.category;
      if (category === 'unknown') {
        continue;
      }
      const fold = getOrCreateFold(perFile, rel, category as ContextInsightCategory);
      if (entry.status === 'applied') {
        markApplied(fold, entry.estimatedTokens ?? estimateTokensForRepoFile(workspaceCwd, rel));
      } else {
        fold.skipReason = fold.skipReason ?? classifySkipReason(entry.skipReason);
      }
    }

    // 2. Customization files listed in the system prompt (the primary signal).
    for (const text of signals.systemInstructions) {
      for (const listed of parseSystemPromptContextFiles(text)) {
        foldAppliedFile(perFile, listed.name, listed.filePath, workspaceCwd, index);
      }
    }

    // 3. `read_file` tool calls that targeted customization paths.
    for (const read of signals.toolReads) {
      foldAppliedFile(perFile, baseNameOf(read.filePath), read.filePath, workspaceCwd, index);
    }

    for (const [rel, fold] of perFile) {
      observations.push({
        startTimeMs: session.startTimeMs,
        sessionKey: session.sessionKey,
        repository: session.repository,
        contextFile: rel,
        category: fold.category,
        applied: fold.applied,
        estTokens: fold.applied ? safeNonNegInt(fold.estTokens) : 0,
        skipReason: fold.applied ? undefined : (fold.skipReason ?? 'other'),
        hadError: session.hadError,
        hadDeviation: session.hadDeviation,
      });
    }
  }

  return observations;
}

/** Get (or create) the per-file fold for a resolved repo-relative path. */
function getOrCreateFold(
  perFile: Map<string, FileFold>,
  rel: string,
  category: ContextInsightCategory,
): FileFold {
  let fold = perFile.get(rel);
  if (fold === undefined) {
    fold = { category, applied: false, estTokens: 0 };
    perFile.set(rel, fold);
  }
  return fold;
}

/** Mark a fold applied, keeping the largest seen token estimate. */
function markApplied(fold: FileFold, estTokens: number): void {
  fold.applied = true;
  if (estTokens > fold.estTokens) {
    fold.estTokens = estTokens;
  }
}

/**
 * Resolve a listed/read customization file to its repo-relative path and fold it
 * in as `applied` (its content entered the session's context envelope). Files
 * that do not resolve to a unique in-repo allowlisted path are dropped.
 */
function foldAppliedFile(
  perFile: Map<string, FileFold>,
  name: string,
  filePath: string | undefined,
  workspaceCwd: string | undefined,
  index: RepoCustomizationIndex,
): void {
  const rel = resolveRepoRelativePath(name, filePath, workspaceCwd, index);
  if (rel === undefined) {
    return;
  }
  const category = categoryForCustomizationFile(rel);
  if (category === 'unknown') {
    return;
  }
  const fold = getOrCreateFold(perFile, rel, category as ContextInsightCategory);
  markApplied(fold, estimateTokensForRepoFile(workspaceCwd, rel));
}

/** Last path segment, treating both `/` and `\` as separators. */
function baseNameOf(p: string): string {
  const segments = p.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] ?? p;
}

/** Map a free-text skip reason into the closed taxonomy (never transmits the text). */
export function classifySkipReason(reason: string | undefined): SkipReasonCategory {
  if (reason !== undefined && /apply\s*to/i.test(reason) && /match/i.test(reason)) {
    return 'applyToNoMatch';
  }
  return 'other';
}

/** Estimate token weight from on-disk file size (metadata only; never reads contents). */
function estimateTokensForRepoFile(workspaceCwd: string | undefined, relativePath: string): number {
  if (workspaceCwd === undefined) {
    return 0;
  }
  try {
    const size = fs.statSync(path.join(workspaceCwd, relativePath)).size;
    return Math.ceil(size / CHARS_PER_TOKEN);
  } catch {
    return 0;
  }
}

function safeNonNegInt(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}
