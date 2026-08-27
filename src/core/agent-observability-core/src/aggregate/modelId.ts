/**
 * Model-id sanitizer for the cloud aggregation path (privacy + contract guard).
 *
 * The ingestion API rejects the WHOLE batch if any bucket's `model` is empty or
 * contains a character outside the allowed set `[A-Za-z0-9._:\-/]` (max 128
 * chars) — see `AggregateBatchValidator.ModelRegex` /
 * `schemas/aggregate-batch.schema.json`. Source telemetry, however, can carry a
 * raw model string that is a human-facing display name rather than a clean id
 * (e.g. Copilot's `Claude Sonnet 4.5` or `GPT-4o (Preview)`), which has spaces /
 * parentheses and so fails the server regex.
 *
 * This is the SAME producer-side chokepoint pattern as {@link mapToolName} (tool
 * names) and {@link sanitizeRepositoryUrl} (repositories): the cloud producers
 * map their field to a contract-safe value BEFORE it reaches a bucket grain or
 * payload, and the aggregator trusts the result. It is applied ONLY on the cloud
 * path — local views keep the original friendly model name via `resolveModel`.
 */

/** Literal substituted for a blank / information-free model id. */
export const UNKNOWN_MODEL = 'unknown';

/** Max model-id length the server accepts (mirrors the validator/schema). */
const MAX_MODEL_ID_LENGTH = 128;

/** Any run of characters OUTSIDE the server-allowed set `[A-Za-z0-9._:\-/]`. */
const DISALLOWED = /[^A-Za-z0-9._:/-]+/g;

/**
 * Map a raw model string to a contract-safe model id: runs of disallowed
 * characters collapse to a single `-`, leading/trailing `-` noise is trimmed,
 * and the result is capped at 128 chars. A null/undefined/blank input, or one
 * left with no alphanumeric content, becomes the literal {@link UNKNOWN_MODEL}.
 * The output ALWAYS satisfies the server's `model` regex.
 */
export function sanitizeModelId(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) {
    return UNKNOWN_MODEL;
  }
  const cleaned = raw.trim().replace(DISALLOWED, '-').replace(/^-+|-+$/g, '');
  if (cleaned.length === 0 || !/[A-Za-z0-9]/.test(cleaned)) {
    return UNKNOWN_MODEL;
  }
  return cleaned.slice(0, MAX_MODEL_ID_LENGTH);
}
