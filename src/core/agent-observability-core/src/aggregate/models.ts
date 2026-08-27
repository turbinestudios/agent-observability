/**
 * Aggregate batch model shapes (Phase 5 cloud producer side).
 *
 * These types match — field-for-field, name-for-name — the strict JSON Schema
 * (`schemas/aggregate-batch.schema.json`) and the canonical TypeScript interface
 * in `docs/architecture/aggregate-payload-schema-v1.md` §10. The schema sets
 * `additionalProperties: false` at every object level, so any field NOT declared
 * here would cause the ingestion API to reject the whole batch — which is the
 * privacy-enforcement mechanism. Keep these shapes in lockstep with the schema.
 *
 * Privacy invariants baked into the shape:
 * - Only pre-aggregated, non-sensitive measures travel.
 * - Identity is the opaque `pseudonymousDeveloperId` only — never an email.
 * - `repository` is the SANITIZED canonical URL (or `unknown`).
 * - `repositoryBranch` is OMITTED by default (not even modelled as emitted here;
 *   the field exists in the schema for opt-in orgs but the aggregator never sets it).
 * - The local-only identity `tier` marker has NO slot here and is never attached.
 */

/** Contract version. Always `"1.0"` in v1. */
export type SchemaVersion = '1.0';

/** OTEL `operation_name` / `gen_ai.operation.name` — the 4 permitted values. */
export type Operation = 'chat' | 'execute_tool' | 'execute_hook' | 'invoke_agent';

/**
 * FIXED canonical latency-histogram upper bounds (ms), shared by EVERY row so
 * histograms from different rows/developers/batches are element-wise mergeable.
 * MUST equal the schema `latencyHistogram.boundsMs` const exactly.
 */
export const LATENCY_BOUNDS_MS: readonly number[] = [
  100, 250, 500, 1000, 2000, 5000, 10000, 30000,
];

/** v1 global invariant: every bucket spans exactly 30 minutes (1800 seconds). */
export const BUCKET_DURATION_SECONDS = 1800 as const;

/** Schema-mandated `bucketDurationSeconds` const, exposed for assertions. */
export type BucketDurationSeconds = typeof BUCKET_DURATION_SECONDS;

/**
 * Fixed-bound duration histogram enabling mergeable approximate percentiles.
 * `counts` has length `boundsMs.length + 1` (= 9); the final element is the
 * `+Inf` overflow bucket (duration > 30000 ms).
 */
export interface LatencyHistogram {
  /** Must equal {@link LATENCY_BOUNDS_MS}. */
  boundsMs: number[];
  /** Length = boundsMs.length + 1 (= 9); last element is the +Inf overflow bucket. */
  counts: number[];
}

/**
 * One aggregate row at the grain
 * `(bucketStart, bucketDurationSeconds, repository, model, agentMode, operation, toolName?)`
 * scoped to the envelope's single `pseudonymousDeveloperId`.
 */
export interface AggregateBucket {
  /** Stable per-row idempotency key (hash of the grain tuple + developer id). */
  rowKey: string;
  /** Aligned UTC bin start (ISO 8601), always 30-minute-aligned in v1. */
  bucketStart: string;
  /** Bin width in seconds — const 1800 (30 minutes). */
  bucketDurationSeconds: BucketDurationSeconds;
  /** SANITIZED `https://{host}/{owner}/{repo}` or `unknown`. */
  repository: string;
  /** OPTIONAL and OMITTED by default (privacy). The aggregator never sets it. */
  repositoryBranch?: string;
  /** Resolved model id, or `unknown`. */
  model: string;
  /** Mapped chat mode (`default` default); non-{default,ask,edit,agent} → `custom`. */
  agentMode: string;
  /** One of the 4 operation enum values. */
  operation: Operation;
  /** Present only when `operation === 'execute_tool'`; non-builtin → `custom`. */
  toolName?: string;

  /** Total spans aggregated into this row (additive). */
  interactionCount: number;
  /** Spans with `status_code` ∈ {0 unset, 1 ok} (additive). */
  successCount: number;
  /** Spans with `status_code === 2` (error) (additive). */
  errorCount: number;
  /** Σ input_tokens over chat spans (additive). */
  inputTokens: number;
  /** Σ output_tokens over chat spans (additive). */
  outputTokens: number;
  /** Σ cached_tokens over chat spans (additive). */
  cachedTokens: number;
  /** OPTIONAL Σ reasoning_tokens; omitted when zero/absent. */
  reasoningTokens?: number;
  /** Σ span durations in ms (additive). */
  durationMsSum: number;
  /** Fixed-bound latency histogram (counts additive bound-for-bound). */
  latencyHistogram: LatencyHistogram;
  /** Distinct sessions within THIS row only. NOT additive across rows. */
  distinctSessionCount: number;
  /** OPTIONAL Unix epoch ms of the latest span start in this row (max over row). */
  lastActivityAtMs?: number;
}

/** Closed-open UTC range `[start, end)` covered by the batch's buckets. */
export interface AggregateWindow {
  /** Inclusive UTC start (ISO 8601). */
  start: string;
  /** Exclusive UTC end (ISO 8601), MUST be greater than start. */
  end: string;
}

/** The top-level batch envelope: one contiguous window for one developer. */
export interface AggregateBatch {
  /** Always `"1.0"`. */
  schemaVersion: SchemaVersion;
  /** Deterministic batch idempotency hint. */
  batchId: string;
  /** UTC time the extension built the batch (ISO 8601). Diagnostics only. */
  generatedAt: string;
  /** Extension semver. */
  toolVersion: string;
  /** Opaque salted developer id: `dev_` + 32 lowercase hex. */
  pseudonymousDeveloperId: string;
  /** Covered window. */
  window: AggregateWindow;
  /** Pre-aggregated rows (may be empty — a valid no-activity heartbeat). */
  buckets: AggregateBucket[];
}
