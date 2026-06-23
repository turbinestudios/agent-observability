/**
 * Pure aggregation engine for context-insights: turns per-(session, file)
 * {@link ContextFileObservation}s into a strict {@link ContextInsightsBatch}.
 *
 * Mirrors `aggregator.ts` (the interaction-metrics engine): a deterministic,
 * `vscode`-free transform over plain objects, fully headless-testable. Grain =
 * `(bucketStart, repository, contextFile, category)`; `rowKey`/`batchId` are
 * deterministic SHA-256 hex using the SAME recipe as the aggregate batch so
 * producer and server agree on row identity (latest-wins upsert).
 */

import { createHash } from 'node:crypto';
import { floorToBucketMs } from './aggregator';
import { BUCKET_DURATION_SECONDS } from './models';
import type {
  ContextFileRow,
  ContextInsightCategory,
  ContextInsightsBatch,
  SkipReasonCounts,
} from './contextInsightsModels';
import type { ContextFileObservation, SkipReasonCategory } from './contextInsightsExtractor';

/** Field separator for hash inputs (matches the aggregate batch recipe). */
const SEP = '|';

/** Inputs to {@link buildContextInsightsBatch}. */
export interface BuildContextInsightsBatchInput {
  /** Resolved, repo-scoped observations to aggregate. */
  observations: readonly ContextFileObservation[];
  /** Opaque salted developer id (`dev_` + 32 hex). */
  pseudonymousDeveloperId: string;
  /** Extension semver. */
  toolVersion: string;
  /** Inclusive UTC window start (epoch ms). */
  windowStartMs: number;
  /** Exclusive UTC window end (epoch ms), MUST be greater than start. */
  windowEndMs: number;
  /** Optional fixed "now" for `generatedAt` (epoch ms). Testing seam. */
  generatedAtMs?: number;
}

/** Mutable per-row accumulator, keyed by the grain string. */
interface RowAccumulator {
  bucketStartMs: number;
  repository: string;
  contextFile: string;
  category: ContextInsightCategory;
  appliedCount: number;
  skippedCount: number;
  applyToNoMatch: number;
  otherSkips: number;
  estTokensSum: number;
  estTokensMax: number;
  sessions: Set<string>;
  errorSessions: Set<string>;
  deviationSessions: Set<string>;
  lastActivityAtMs: number;
}

/**
 * Build a strict {@link ContextInsightsBatch} from resolved observations.
 *
 * Deterministic: the same input yields a byte-identical batch except
 * `generatedAt`. Run twice with the same observations/window/developer and
 * `batchId` + every `rowKey` are identical.
 */
export function buildContextInsightsBatch(input: BuildContextInsightsBatchInput): ContextInsightsBatch {
  const { observations, pseudonymousDeveloperId, toolVersion, windowStartMs, windowEndMs } = input;

  const accumulators = new Map<string, RowAccumulator>();

  for (const obs of observations) {
    const bucketStartMs = floorToBucketMs(obs.startTimeMs);
    const grain = grainKey(bucketStartMs, obs.repository, obs.contextFile, obs.category);

    let acc = accumulators.get(grain);
    if (acc === undefined) {
      acc = {
        bucketStartMs,
        repository: obs.repository,
        contextFile: obs.contextFile,
        category: obs.category,
        appliedCount: 0,
        skippedCount: 0,
        applyToNoMatch: 0,
        otherSkips: 0,
        estTokensSum: 0,
        estTokensMax: 0,
        sessions: new Set<string>(),
        errorSessions: new Set<string>(),
        deviationSessions: new Set<string>(),
        lastActivityAtMs: 0,
      };
      accumulators.set(grain, acc);
    }

    acc.sessions.add(obs.sessionKey);
    if (obs.startTimeMs > acc.lastActivityAtMs) {
      acc.lastActivityAtMs = obs.startTimeMs;
    }

    if (obs.applied) {
      acc.appliedCount += 1;
      const est = safeInt(obs.estTokens);
      acc.estTokensSum += est;
      if (est > acc.estTokensMax) {
        acc.estTokensMax = est;
      }
      // Friction is attributed to applied sessions only (the file was in context).
      if (obs.hadError) {
        acc.errorSessions.add(obs.sessionKey);
      }
      if (obs.hadDeviation) {
        acc.deviationSessions.add(obs.sessionKey);
      }
    } else {
      acc.skippedCount += 1;
      if ((obs.skipReason ?? 'other') === 'applyToNoMatch') {
        acc.applyToNoMatch += 1;
      } else {
        acc.otherSkips += 1;
      }
    }
  }

  const rows: ContextFileRow[] = [...accumulators.values()]
    .sort(compareAccumulators)
    .map((acc) => toRow(acc, pseudonymousDeveloperId));

  const windowStartIso = toIso(windowStartMs);
  const windowEndIso = toIso(windowEndMs);

  return {
    schemaVersion: '1.0',
    batchId: computeBatchId(pseudonymousDeveloperId, windowStartIso, windowEndIso),
    generatedAt: toIso(input.generatedAtMs ?? Date.now()),
    toolVersion,
    pseudonymousDeveloperId,
    window: { start: windowStartIso, end: windowEndIso },
    rows,
  };
}

/** Materialize one accumulator into a schema-shaped {@link ContextFileRow}. */
function toRow(acc: RowAccumulator, developerId: string): ContextFileRow {
  const row: ContextFileRow = {
    rowKey: computeRowKey(developerId, acc),
    bucketStart: toIso(acc.bucketStartMs),
    bucketDurationSeconds: BUCKET_DURATION_SECONDS,
    repository: acc.repository,
    contextFile: acc.contextFile,
    category: acc.category,
    appliedCount: acc.appliedCount,
    skippedCount: acc.skippedCount,
    estTokensSum: acc.estTokensSum,
    estTokensMax: acc.estTokensMax,
    sessionsWithErrorCount: acc.errorSessions.size,
    sessionsWithDeviationCount: acc.deviationSessions.size,
    distinctSessionCount: acc.sessions.size,
  };

  // skipReasonCounts only when there were skips; include only non-zero buckets.
  if (acc.skippedCount > 0) {
    const counts: SkipReasonCounts = {};
    if (acc.applyToNoMatch > 0) {
      counts.applyToNoMatch = acc.applyToNoMatch;
    }
    if (acc.otherSkips > 0) {
      counts.other = acc.otherSkips;
    }
    row.skipReasonCounts = counts;
  }

  if (acc.lastActivityAtMs > 0) {
    row.lastActivityAtMs = acc.lastActivityAtMs;
  }

  return row;
}

/** Grain join string used as the accumulator key (developer id prepended for rowKey). */
function grainKey(
  bucketStartMs: number,
  repository: string,
  contextFile: string,
  category: string,
): string {
  return [toIso(bucketStartMs), String(BUCKET_DURATION_SECONDS), repository, contextFile, category].join(SEP);
}

/**
 * `rowKey = sha256hex([developerId, bucketStartIso, 1800, repository, contextFile,
 * category].join('|'))`.
 */
function computeRowKey(developerId: string, acc: RowAccumulator): string {
  const material = [
    developerId,
    toIso(acc.bucketStartMs),
    String(BUCKET_DURATION_SECONDS),
    acc.repository,
    acc.contextFile,
    acc.category,
  ].join(SEP);
  return sha256Hex(material);
}

/** `batchId = sha256hex([developerId, windowStartIso, windowEndIso, '1.0'].join('|'))`. */
function computeBatchId(developerId: string, windowStartIso: string, windowEndIso: string): string {
  return sha256Hex([developerId, windowStartIso, windowEndIso, '1.0'].join(SEP));
}

/** Lowercase hex SHA-256 over UTF-8 of `material`. */
function sha256Hex(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** Stable, deterministic row ordering (so the output array is reproducible). */
function compareAccumulators(a: RowAccumulator, b: RowAccumulator): number {
  if (a.bucketStartMs !== b.bucketStartMs) {
    return a.bucketStartMs - b.bucketStartMs;
  }
  return (
    cmp(a.repository, b.repository) ||
    cmp(a.contextFile, b.contextFile) ||
    cmp(a.category, b.category)
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Coerce a possibly-non-finite token count to a non-negative integer. */
function safeInt(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

/** Render an epoch-ms timestamp as an ISO 8601 UTC string (`...Z`). */
function toIso(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/** Re-export for callers building the friction `skipReason` taxonomy. */
export type { SkipReasonCategory };
