import { createHash } from 'node:crypto';
import { buildBatch, type AggregationRow } from '../aggregate/aggregator';
import { buildContextInsightsBatch } from '../aggregate/contextInsightsAggregator';
import type { ContextFileObservation } from '../aggregate/contextInsightsExtractor';
import { REPOSITORY_PATTERN } from '../telemetry/repositoryUrl';
import {
  OUTCOME_SOURCES,
  TEAM_SHARD_MAX_WINDOW_DAYS,
  TEAM_SHARD_SCHEMA_VERSION,
  emptyVerdictCounts,
  type OutcomeCostMode,
  type OutcomeRow,
  type OutcomeSource,
  type OutcomeVerdict,
  type TeamShard,
  type VerdictCounts,
} from './teamShardModels';

/**
 * Builds a {@link TeamShard}: the UNCHANGED aggregate and context-insights
 * batches from their own core builders, plus the `outcomes` block.
 *
 * Deterministic like the batch builders: the same input yields a byte-identical
 * shard except `generatedAt` (and the embedded batches' `generatedAt`). Nothing
 * here reads the machine; the datahost collects the inputs and hands them in.
 */

const SEP = '|';
const DAY_MS = 86_400_000;
const VALID_SOURCES: ReadonlySet<string> = new Set(OUTCOME_SOURCES);

/** One session's outcome as the index knows it, before grouping. */
export interface OutcomeInput {
  /** When the session ended (epoch ms); decides its UTC day. */
  endedAtMs: number;
  /** SANITIZED repository (canonical URL or `unknown`). */
  repository: string;
  /** Source id; anything outside {@link OUTCOME_SOURCES} is dropped. */
  source: string;
  /** The retrospective's verdict, or undefined when not judged. */
  verdict: OutcomeVerdict | undefined;
  /** Integer micro-USD, or undefined when the session could not be priced. */
  costMicros: number | undefined;
  costMode: OutcomeCostMode;
}

export interface BuildTeamShardInput {
  rows: readonly AggregationRow[];
  observations: readonly ContextFileObservation[];
  outcomes: readonly OutcomeInput[];
  /** Opaque salted developer id (`dev_` + 32 hex). */
  pseudonymousDeveloperId: string;
  /** Desktop app semver. */
  toolVersion: string;
  /** Inclusive UTC window start (epoch ms). */
  windowStartMs: number;
  /** Exclusive UTC window end (epoch ms), MUST be greater than start. */
  windowEndMs: number;
  /** Optional fixed "now" for `generatedAt` (epoch ms). Testing seam. */
  generatedAtMs?: number;
}

/** `YYYY-MM-DD` in UTC. The producer buckets; importers never re-bin. */
export function utcDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Enforce `end > start` and a span of at most {@link TEAM_SHARD_MAX_WINDOW_DAYS}
 * days by moving `start` forward. A non-positive span yields a one-millisecond
 * window ending at `end`, so the result always validates.
 */
export function clampTeamWindow(startMs: number, endMs: number): { startMs: number; endMs: number } {
  const maxSpan = TEAM_SHARD_MAX_WINDOW_DAYS * DAY_MS;
  let start = startMs;
  if (endMs - start > maxSpan) {
    start = endMs - maxSpan;
  }
  if (start >= endMs) {
    start = endMs - 1;
  }
  return { startMs: start, endMs };
}

export function buildTeamShard(input: BuildTeamShardInput): TeamShard {
  const { pseudonymousDeveloperId, toolVersion, windowStartMs, windowEndMs } = input;
  const generatedAtMs = input.generatedAtMs ?? Date.now();

  const aggregate = buildBatch({
    rows: [...input.rows],
    pseudonymousDeveloperId,
    toolVersion,
    windowStartMs,
    windowEndMs,
    generatedAtMs,
  });
  const contextInsights = buildContextInsightsBatch({
    observations: input.observations,
    pseudonymousDeveloperId,
    toolVersion,
    windowStartMs,
    windowEndMs,
    generatedAtMs,
  });

  return {
    schemaVersion: TEAM_SHARD_SCHEMA_VERSION,
    generatedAt: new Date(generatedAtMs).toISOString(),
    toolVersion,
    pseudonymousDeveloperId,
    // Equal to aggregate.window by construction: same inputs, same formatter.
    window: { start: aggregate.window.start, end: aggregate.window.end },
    aggregate,
    contextInsights,
    outcomes: buildOutcomeRows(input.outcomes, pseudonymousDeveloperId, windowStartMs, windowEndMs),
  };
}

interface OutcomeAccumulator {
  day: string;
  repository: string;
  source: OutcomeSource;
  sessionCount: number;
  verdictCounts: VerdictCounts;
  costMicros: number;
  pricedSessionCount: number;
  costMode: OutcomeCostMode;
}

/**
 * Group outcomes by (UTC day, repository, source). Rows outside the window,
 * from an unknown source, or with a repository that fails the contracts'
 * pattern are DROPPED, never coerced — the same rule the aggregator applies to
 * its operation enum.
 */
export function buildOutcomeRows(
  outcomes: readonly OutcomeInput[],
  developerId: string,
  windowStartMs: number,
  windowEndMs: number,
): OutcomeRow[] {
  const accumulators = new Map<string, OutcomeAccumulator>();

  for (const outcome of outcomes) {
    if (!Number.isFinite(outcome.endedAtMs) || outcome.endedAtMs < windowStartMs || outcome.endedAtMs >= windowEndMs) {
      continue;
    }
    if (!VALID_SOURCES.has(outcome.source)) {
      continue;
    }
    if (!REPOSITORY_PATTERN.test(outcome.repository)) {
      continue;
    }
    const day = utcDay(outcome.endedAtMs);
    const source = outcome.source as OutcomeSource;
    const key = [day, outcome.repository, source].join(SEP);
    let acc = accumulators.get(key);
    if (acc === undefined) {
      acc = {
        day,
        repository: outcome.repository,
        source,
        sessionCount: 0,
        verdictCounts: emptyVerdictCounts(),
        costMicros: 0,
        pricedSessionCount: 0,
        costMode: outcome.costMode,
      };
      accumulators.set(key, acc);
    }
    acc.sessionCount += 1;
    acc.verdictCounts[outcome.verdict ?? 'unjudged'] += 1;
    if (outcome.costMicros !== undefined && Number.isFinite(outcome.costMicros) && outcome.costMicros >= 0) {
      acc.costMicros += Math.round(outcome.costMicros);
      acc.pricedSessionCount += 1;
    }
  }

  return [...accumulators.values()]
    .sort(
      (a, b) =>
        compare(a.day, b.day) || compare(a.repository, b.repository) || compare(a.source, b.source),
    )
    .map((acc) => ({
      rowKey: computeOutcomeRowKey(developerId, acc.day, acc.repository, acc.source),
      day: acc.day,
      repository: acc.repository,
      source: acc.source,
      sessionCount: acc.sessionCount,
      verdictCounts: acc.verdictCounts,
      costMicros: acc.costMicros,
      pricedSessionCount: acc.pricedSessionCount,
      costMode: acc.costMode,
    }));
}

/** SHA-256 hex of `devId|day|repository|source` — the row's idempotent identity. */
export function computeOutcomeRowKey(developerId: string, day: string, repository: string, source: string): string {
  return createHash('sha256').update([developerId, day, repository, source].join(SEP), 'utf8').digest('hex');
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
