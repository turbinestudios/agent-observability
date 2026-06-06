import { createHash } from 'node:crypto';
import {
  AggregateBatch,
  AggregateBucket,
  LatencyHistogram,
  LATENCY_BOUNDS_MS,
  BUCKET_DURATION_SECONDS,
  Operation,
} from './models';

/**
 * Pure aggregation engine: turns safe per-span metadata rows into a strict,
 * privacy-first {@link AggregateBatch}.
 *
 * This module imports neither `vscode` nor `node-sqlite3-wasm`; it is a deterministic
 * transform over plain {@link AggregationRow} objects, so it is fully headless-
 * testable and reusable by the preview command and the (future) sync engine.
 *
 * Privacy/idempotency invariants (see `docs/architecture/aggregate-payload-schema-v1.md`):
 * - Bins are floored to fixed 30-minute UTC boundaries (`bucketDurationSeconds = 1800`).
 * - Grain = (bucketStart, repository, model, agentMode, operation, toolName?).
 * - `rowKey` / `batchId` are deterministic SHA-256 hex over the grain/window —
 *   identical input => identical ids (idempotent, latest-wins server-side upsert).
 * - Rows whose `operation` is outside the 4-value enum are SKIPPED (never invented).
 * - `repositoryBranch` is never emitted; `reasoningTokens` omitted when zero/absent.
 */

/** The 30-minute bin width in milliseconds, derived from the global invariant. */
const BUCKET_DURATION_MS = BUCKET_DURATION_SECONDS * 1000;

/** The 4 permitted OTEL operations; rows outside this set are skipped. */
const VALID_OPERATIONS: ReadonlySet<string> = new Set<Operation>([
  'chat',
  'execute_tool',
  'execute_hook',
  'invoke_agent',
]);

/** Field separator for hash inputs (matches the doc's unit-separator recipe). */
const SEP = '|';

/**
 * One span projected to ONLY safe aggregation metadata (no raw content). Produced
 * by `TelemetryDatabase.getAggregationRows` and consumed here. `repository`,
 * `agentMode`, and `toolName` are ALREADY sanitized/mapped by the producer — this
 * module performs no further free-text mapping, it only bins and sums.
 */
export interface AggregationRow {
  /** `spans.start_time_ms` (epoch ms). */
  startTimeMs: number;
  /** Resolved session key: `COALESCE(conversation_id, chat_session_id)`. */
  sessionKey: string;
  /** SANITIZED repository (canonical URL or `unknown`). */
  repository: string;
  /** Resolved model id, or `unknown`. */
  model: string;
  /** Mapped agent mode (one of default/ask/edit/agent/custom). */
  agentMode: string;
  /** OTEL operation name (validated against the enum here). */
  operation: string;
  /** Mapped tool name for `execute_tool` rows (builtin verbatim, else `custom`). */
  toolName?: string;
  /** `end_time_ms - start_time_ms` (ms). */
  durationMs: number;
  /** OTEL `status_code` (0 unset, 1 ok, 2 error). */
  statusCode: number;
  /** `input_tokens` (chat spans), else 0. */
  inputTokens: number;
  /** `output_tokens` (chat spans), else 0. */
  outputTokens: number;
  /** `cached_tokens` (chat spans), else 0. */
  cachedTokens: number;
  /** `reasoning_tokens` (chat spans), else 0/absent. */
  reasoningTokens?: number;
}

/** Inputs to {@link buildBatch}. */
export interface BuildBatchInput {
  /** Safe per-span rows to aggregate. */
  rows: AggregationRow[];
  /** Opaque salted developer id (`dev_` + 32 hex). */
  pseudonymousDeveloperId: string;
  /** Extension semver. */
  toolVersion: string;
  /** Inclusive UTC window start (epoch ms). */
  windowStartMs: number;
  /** Exclusive UTC window end (epoch ms), MUST be greater than start. */
  windowEndMs: number;
  /**
   * Optional fixed "now" for `generatedAt` (epoch ms). Testing seam so callers can
   * pin the diagnostic timestamp; it is NOT part of any idempotency key.
   */
  generatedAtMs?: number;
}

/** Mutable per-bucket accumulator, keyed by the grain string. */
interface BucketAccumulator {
  bucketStartMs: number;
  repository: string;
  model: string;
  agentMode: string;
  operation: Operation;
  toolName?: string;
  interactionCount: number;
  successCount: number;
  errorCount: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  durationMsSum: number;
  counts: number[];
  sessions: Set<string>;
  lastActivityAtMs: number;
}

/**
 * Build a strict {@link AggregateBatch} from safe metadata rows.
 *
 * Deterministic: the same input yields a byte-identical batch except for
 * `generatedAt` (informational, not part of any idempotency key). Run twice with
 * the same rows/window/developer and `batchId` + every `rowKey` are identical.
 */
export function buildBatch(input: BuildBatchInput): AggregateBatch {
  const { rows, pseudonymousDeveloperId, toolVersion, windowStartMs, windowEndMs } = input;

  const accumulators = new Map<string, BucketAccumulator>();

  for (const row of rows) {
    // SKIP rows whose operation is outside the enum — never invent a value.
    if (!VALID_OPERATIONS.has(row.operation)) {
      continue;
    }
    const operation = row.operation as Operation;

    // toolName is meaningful only for execute_tool; drop it otherwise so it never
    // pollutes the grain of non-tool operations.
    const toolName = operation === 'execute_tool' ? row.toolName : undefined;

    const bucketStartMs = floorToBucketMs(row.startTimeMs);
    const grain = grainKey(
      bucketStartMs,
      row.repository,
      row.model,
      row.agentMode,
      operation,
      toolName,
    );

    let acc = accumulators.get(grain);
    if (acc === undefined) {
      acc = {
        bucketStartMs,
        repository: row.repository,
        model: row.model,
        agentMode: row.agentMode,
        operation,
        toolName,
        interactionCount: 0,
        successCount: 0,
        errorCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        durationMsSum: 0,
        counts: new Array<number>(LATENCY_BOUNDS_MS.length + 1).fill(0),
        sessions: new Set<string>(),
        lastActivityAtMs: 0,
      };
      accumulators.set(grain, acc);
    }

    acc.interactionCount += 1;
    if (row.statusCode === 2) {
      acc.errorCount += 1;
    } else {
      // status_code in {0 unset, 1 ok} (and any non-2) counts as success.
      acc.successCount += 1;
    }

    acc.inputTokens += safeInt(row.inputTokens);
    acc.outputTokens += safeInt(row.outputTokens);
    acc.cachedTokens += safeInt(row.cachedTokens);
    acc.reasoningTokens += safeInt(row.reasoningTokens);

    const duration = Number.isFinite(row.durationMs) && row.durationMs > 0 ? row.durationMs : 0;
    acc.durationMsSum += duration;
    acc.counts[histogramIndex(duration)] += 1;

    if (row.sessionKey !== undefined && row.sessionKey !== null && row.sessionKey.length > 0) {
      acc.sessions.add(row.sessionKey);
    }
    if (row.startTimeMs > acc.lastActivityAtMs) {
      acc.lastActivityAtMs = row.startTimeMs;
    }
  }

  const buckets: AggregateBucket[] = [...accumulators.values()]
    .sort(compareAccumulators)
    .map((acc) => toBucket(acc, pseudonymousDeveloperId));

  const windowStartIso = toIso(windowStartMs);
  const windowEndIso = toIso(windowEndMs);

  return {
    schemaVersion: '1.0',
    batchId: computeBatchId(pseudonymousDeveloperId, windowStartIso, windowEndIso),
    generatedAt: toIso(input.generatedAtMs ?? Date.now()),
    toolVersion,
    pseudonymousDeveloperId,
    window: { start: windowStartIso, end: windowEndIso },
    buckets,
  };
}

/** Floor an epoch-ms timestamp to its 30-minute UTC bucket boundary (epoch ms). */
export function floorToBucketMs(timeMs: number): number {
  return Math.floor(timeMs / BUCKET_DURATION_MS) * BUCKET_DURATION_MS;
}

/**
 * Index of the histogram bucket for a duration (ms): the first bound it is `<=`,
 * else the final `+Inf` overflow bucket (index = bounds.length).
 */
function histogramIndex(durationMs: number): number {
  for (let i = 0; i < LATENCY_BOUNDS_MS.length; i += 1) {
    if (durationMs <= LATENCY_BOUNDS_MS[i]) {
      return i;
    }
  }
  return LATENCY_BOUNDS_MS.length;
}

/** Materialize one accumulator into a schema-shaped {@link AggregateBucket}. */
function toBucket(acc: BucketAccumulator, developerId: string): AggregateBucket {
  const histogram: LatencyHistogram = {
    boundsMs: [...LATENCY_BOUNDS_MS],
    counts: acc.counts,
  };

  const bucket: AggregateBucket = {
    rowKey: computeRowKey(developerId, acc),
    bucketStart: toIso(acc.bucketStartMs),
    bucketDurationSeconds: BUCKET_DURATION_SECONDS,
    repository: acc.repository,
    model: acc.model,
    agentMode: acc.agentMode,
    operation: acc.operation,
    interactionCount: acc.interactionCount,
    successCount: acc.successCount,
    errorCount: acc.errorCount,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    cachedTokens: acc.cachedTokens,
    durationMsSum: acc.durationMsSum,
    latencyHistogram: histogram,
    distinctSessionCount: acc.sessions.size,
  };

  // toolName only for execute_tool (omitted otherwise per the schema).
  if (acc.operation === 'execute_tool' && acc.toolName !== undefined) {
    bucket.toolName = acc.toolName;
  }
  // reasoningTokens omitted when zero/absent (optional field).
  if (acc.reasoningTokens > 0) {
    bucket.reasoningTokens = acc.reasoningTokens;
  }
  // lastActivityAtMs: max span start in the row (optional but always derivable here).
  if (acc.lastActivityAtMs > 0) {
    bucket.lastActivityAtMs = acc.lastActivityAtMs;
  }

  return bucket;
}

/**
 * Grain join string used both as the in-memory accumulator key AND as the
 * `rowKey` hash input (with the developer id prepended). Optional `toolName`
 * renders as the empty string per the doc's recipe.
 */
function grainKey(
  bucketStartMs: number,
  repository: string,
  model: string,
  agentMode: string,
  operation: string,
  toolName: string | undefined,
): string {
  return [
    toIso(bucketStartMs),
    String(BUCKET_DURATION_SECONDS),
    repository,
    model,
    agentMode,
    operation,
    toolName ?? '',
  ].join(SEP);
}

/**
 * `rowKey = sha256hex([developerId, bucketStartIso, 1800, repository, model,
 * agentMode, operation, toolName ?? ''].join('|'))`.
 */
function computeRowKey(developerId: string, acc: BucketAccumulator): string {
  const material = [
    developerId,
    toIso(acc.bucketStartMs),
    String(BUCKET_DURATION_SECONDS),
    acc.repository,
    acc.model,
    acc.agentMode,
    acc.operation,
    acc.toolName ?? '',
  ].join(SEP);
  return sha256Hex(material);
}

/**
 * `batchId = sha256hex([developerId, windowStartIso, windowEndIso, '1.0'].join('|'))`.
 */
function computeBatchId(developerId: string, windowStartIso: string, windowEndIso: string): string {
  return sha256Hex([developerId, windowStartIso, windowEndIso, '1.0'].join(SEP));
}

/** Lowercase hex SHA-256 over UTF-8 of `material`. */
function sha256Hex(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/** Stable, deterministic bucket ordering (so the output array is reproducible). */
function compareAccumulators(a: BucketAccumulator, b: BucketAccumulator): number {
  if (a.bucketStartMs !== b.bucketStartMs) {
    return a.bucketStartMs - b.bucketStartMs;
  }
  return (
    cmp(a.repository, b.repository) ||
    cmp(a.model, b.model) ||
    cmp(a.agentMode, b.agentMode) ||
    cmp(a.operation, b.operation) ||
    cmp(a.toolName ?? '', b.toolName ?? '')
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Coerce a possibly-undefined/non-finite token count to a non-negative integer. */
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
