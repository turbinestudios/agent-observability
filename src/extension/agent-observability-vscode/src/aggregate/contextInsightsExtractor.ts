/**
 * Context-insights extractor — turns local per-session telemetry into safe,
 * repo-scoped {@link ContextFileObservation}s ready for aggregation.
 *
 * For each session it parses discovery/customization events into context-file
 * entries, resolves each to a unique repo-relative customization path (dropping
 * anything that is not an in-repo allowlisted file), and folds the per-agent
 * entries into ONE observation per (session, file) carrying the session's
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

/** Supplies the LOCAL-ONLY discovery/customization events for a session. */
export type DiscoveryEventsProvider = (sessionKey: string) => readonly DiscoveryEventRow[];

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
 * Extract one {@link ContextFileObservation} per (session, resolved file). Tool
 * reads (`status === 'read'`, i.e. source files) and files that do not resolve to
 * a unique in-repo customization path are dropped.
 */
export function extractContextObservations(
  sessions: readonly SessionContext[],
  getDiscoveryEvents: DiscoveryEventsProvider,
  workspaceCwd: string | undefined,
  index: RepoCustomizationIndex,
): ContextFileObservation[] {
  const observations: ContextFileObservation[] = [];

  for (const session of sessions) {
    const events = getDiscoveryEvents(session.sessionKey);
    if (events.length === 0) {
      continue;
    }
    const entries = parseDiscoveryEvents(events);
    if (entries.length === 0) {
      continue;
    }

    const perFile = new Map<string, FileFold>();
    for (const entry of entries) {
      // Tool-read entries are source/doc files — explicitly out of scope.
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

      let fold = perFile.get(rel);
      if (fold === undefined) {
        fold = { category: category as ContextInsightCategory, applied: false, estTokens: 0 };
        perFile.set(rel, fold);
      }

      if (entry.status === 'applied') {
        fold.applied = true;
        const est = entry.estimatedTokens ?? estimateTokensForRepoFile(workspaceCwd, rel);
        if (est > fold.estTokens) {
          fold.estTokens = est;
        }
      } else {
        // skipped
        fold.skipReason = fold.skipReason ?? classifySkipReason(entry.skipReason);
      }
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
