/**
 * Context-insights batch model shapes (producer side).
 *
 * These types match — field-for-field, name-for-name — the strict JSON Schema
 * (`schemas/context-insights-batch.schema.json`) and its companion doc
 * (`docs/architecture/context-insights-schema-v1.md`). The schema sets
 * `additionalProperties: false` at every object level, so any field NOT declared
 * here would cause the ingestion API to reject the whole batch. Keep these shapes
 * in lockstep with the schema.
 *
 * Privacy invariants baked into the shape:
 * - Only CUSTOMIZATION-file paths travel, as repo-relative POSIX strings resolved
 *   inside the developer's workspace (repo-scoped only).
 * - No file contents, no raw skip-reason text (bucketed into {@link SkipReasonCounts}),
 *   no branches, no identities. Identity is the opaque `pseudonymousDeveloperId`.
 */

import type { AggregateWindow, BucketDurationSeconds, SchemaVersion } from './models';

/** Closed customization-file category set (the schema enum; `unknown` is never emitted). */
export type ContextInsightCategory = 'instruction' | 'skill' | 'agent' | 'hook' | 'prompt';

/** Closed-set taxonomy of skip reasons; raw reason text is never transmitted. */
export interface SkipReasonCounts {
  /** Skipped because the file's `applyTo` glob matched no attached/open file. */
  applyToNoMatch?: number;
  /** Skipped for any reason outside the recognized taxonomy (raw reason omitted). */
  other?: number;
}

/**
 * One aggregate row at the grain
 * `(bucketStart, bucketDurationSeconds, repository, contextFile, category)`
 * scoped to the envelope's single `pseudonymousDeveloperId`.
 */
export interface ContextFileRow {
  /** Stable per-row idempotency key (hash of the grain tuple + developer id). */
  rowKey: string;
  /** Aligned UTC bin start (ISO 8601), always 30-minute-aligned in v1. */
  bucketStart: string;
  /** Bin width in seconds — const 1800 (30 minutes). */
  bucketDurationSeconds: BucketDurationSeconds;
  /** SANITIZED `https://{host}/{owner}/{repo}` or `unknown`. */
  repository: string;
  /** Allowlisted repo-relative POSIX path of a customization file. */
  contextFile: string;
  /** Customization-file category (closed set). */
  category: ContextInsightCategory;

  /** Times applied (loaded into context) across sessions in this row (additive). */
  appliedCount: number;
  /** Times discovered but skipped across sessions in this row (additive). */
  skippedCount: number;
  /** OPTIONAL closed-set breakdown of skip reasons; omitted when skippedCount is 0. */
  skipReasonCounts?: SkipReasonCounts;
  /** Σ estimated token weight over applied sessions (additive). */
  estTokensSum: number;
  /** Max single-session estimated token weight (NOT additive; server takes max). */
  estTokensMax: number;
  /** Distinct applied sessions containing ≥1 errored span (additive). Co-occurrence only. */
  sessionsWithErrorCount: number;
  /** Distinct applied sessions with a workflow deviation (additive). Co-occurrence only. */
  sessionsWithDeviationCount: number;
  /** Distinct sessions touching this file within THIS row only. NOT additive. */
  distinctSessionCount: number;
  /** OPTIONAL Unix epoch ms of the latest session start in this row (max over row). */
  lastActivityAtMs?: number;
}

/** The top-level batch envelope: one contiguous window for one developer. */
export interface ContextInsightsBatch {
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
  /** Pre-aggregated context-file rows (may be empty — a valid no-activity heartbeat). */
  rows: ContextFileRow[];
}
