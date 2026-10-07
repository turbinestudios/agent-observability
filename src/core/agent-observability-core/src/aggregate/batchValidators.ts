/**
 * Validators for the aggregate and context-insights batches a team shard
 * embeds, so a batch arriving by FILE is checked against the full contract
 * before it is merged. They began as ports of the retired cloud dashboard's
 * server-side validators and still enforce the same rules.
 *
 * Every object has an allowlist of keys and any other key is an error, which
 * is what `additionalProperties: false` means in the schema.
 *
 * Keep this file in step with the JSON schemas in `schemas/`; the parity tests
 * compile the schemas with ajv and assert both sides agree.
 */

const EXPECTED_SCHEMA_VERSION = '1.0';
const EXPECTED_BUCKET_DURATION_SECONDS = 1800;
const CANONICAL_BOUNDS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000];
const EXPECTED_HISTOGRAM_COUNTS_LENGTH = CANONICAL_BOUNDS_MS.length + 1;

const ALLOWED_OPERATIONS = new Set(['chat', 'execute_tool', 'execute_hook', 'invoke_agent']);
const ALLOWED_AGENT_MODES = new Set(['default', 'ask', 'edit', 'agent', 'custom']);
const ALLOWED_CATEGORIES = new Set(['instruction', 'skill', 'agent', 'hook', 'prompt']);

const DEVELOPER_ID_RE = /^dev_[0-9a-f]{32}$/;
const REPOSITORY_RE = /^(unknown|https?:\/\/[A-Za-z0-9.-]+(:[0-9]+)?\/[^\s@?#]+)$/;
const TOOL_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const MODEL_RE = /^[A-Za-z0-9._:\-/]+$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._\-/]+$/;
const CONTEXT_FILE_RE =
  /^(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9_.-]+\/)*(?:[A-Za-z0-9_.-]+\.(?:instructions|prompt|agent|skill)\.md|copilot-instructions\.md|AGENTS\.md|CLAUDE\.md|SKILL\.md)$/;

const ENVELOPE_KEYS_AGGREGATE = new Set([
  'schemaVersion',
  'batchId',
  'generatedAt',
  'toolVersion',
  'pseudonymousDeveloperId',
  'window',
  'buckets',
]);
const ENVELOPE_KEYS_CONTEXT = new Set([
  'schemaVersion',
  'batchId',
  'generatedAt',
  'toolVersion',
  'pseudonymousDeveloperId',
  'window',
  'rows',
]);
const WINDOW_KEYS = new Set(['start', 'end']);
const BUCKET_KEYS = new Set([
  'rowKey',
  'bucketStart',
  'bucketDurationSeconds',
  'repository',
  'repositoryBranch',
  'model',
  'agentMode',
  'operation',
  'toolName',
  'interactionCount',
  'successCount',
  'errorCount',
  'inputTokens',
  'outputTokens',
  'cachedTokens',
  'reasoningTokens',
  'durationMsSum',
  'latencyHistogram',
  'distinctSessionCount',
  'lastActivityAtMs',
]);
const HISTOGRAM_KEYS = new Set(['boundsMs', 'counts']);
const CONTEXT_ROW_KEYS = new Set([
  'rowKey',
  'bucketStart',
  'bucketDurationSeconds',
  'repository',
  'contextFile',
  'category',
  'appliedCount',
  'skippedCount',
  'skipReasonCounts',
  'estTokensSum',
  'estTokensMax',
  'sessionsWithErrorCount',
  'sessionsWithDeviationCount',
  'distinctSessionCount',
  'lastActivityAtMs',
]);
const SKIP_REASON_KEYS = new Set(['applyToNoMatch', 'other']);

type Obj = Record<string, unknown>;

/** The `schemaVersion` of any object-shaped value, when it is a string. */
export function schemaVersionOf(value: unknown): string | undefined {
  if (!isObject(value)) {
    return undefined;
  }
  const version = value.schemaVersion;
  return typeof version === 'string' ? version : undefined;
}

/** Validate an aggregate batch. `[]` when valid; otherwise one message per problem. */
export function validateAggregateBatch(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ['batch must be a JSON object.'];
  }
  rejectUnknownKeys(value, ENVELOPE_KEYS_AGGREGATE, '', errors);
  validateEnvelope(value, errors);

  if (!Array.isArray(value.buckets)) {
    errors.push('buckets is required (an empty array is valid).');
    return errors;
  }
  value.buckets.forEach((bucket, i) => validateBucket(bucket, i, errors));
  return errors;
}

/** Validate a context-insights batch. `[]` when valid; otherwise one message per problem. */
export function validateContextInsightsBatch(value: unknown): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ['batch must be a JSON object.'];
  }
  rejectUnknownKeys(value, ENVELOPE_KEYS_CONTEXT, '', errors);
  validateEnvelope(value, errors);

  if (!Array.isArray(value.rows)) {
    errors.push('rows is required (an empty array is valid).');
    return errors;
  }
  value.rows.forEach((row, i) => validateContextRow(row, i, errors));
  return errors;
}

// ── shared envelope ──────────────────────────────────────────────────────────

function validateEnvelope(batch: Obj, errors: string[]): void {
  if (batch.schemaVersion !== EXPECTED_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${EXPECTED_SCHEMA_VERSION}' but was '${String(batch.schemaVersion)}'.`);
  }
  if (!isNonBlankString(batch.batchId) || batch.batchId.length > 128) {
    errors.push('batchId must be a non-empty string of at most 128 characters.');
  }
  if (!isDateTimeString(batch.generatedAt)) {
    errors.push('generatedAt must be an ISO 8601 date-time.');
  }
  if (!isNonBlankString(batch.toolVersion) || batch.toolVersion.length > 64 || !TOOL_VERSION_RE.test(batch.toolVersion)) {
    errors.push("toolVersion must be a semantic version (e.g. '1.4.2') of at most 64 characters.");
  }
  validateWindow(batch.window, errors);
  if (typeof batch.pseudonymousDeveloperId !== 'string' || !DEVELOPER_ID_RE.test(batch.pseudonymousDeveloperId)) {
    errors.push('pseudonymousDeveloperId must match ^dev_[0-9a-f]{32}$.');
  }
}

/** Shared by both batches and the shard envelope. */
export function validateWindow(window: unknown, errors: string[], prefix = 'window'): void {
  if (!isObject(window)) {
    errors.push(`${prefix} is required.`);
    return;
  }
  rejectUnknownKeys(window, WINDOW_KEYS, `${prefix}.`, errors);
  const start = parseDateTime(window.start);
  const end = parseDateTime(window.end);
  if (start === undefined || end === undefined) {
    errors.push(`${prefix}.start and ${prefix}.end must be ISO 8601 date-times.`);
    return;
  }
  if (end <= start) {
    errors.push(`${prefix}.end must be greater than ${prefix}.start.`);
  }
}

// ── aggregate buckets ────────────────────────────────────────────────────────

function validateBucket(bucket: unknown, index: number, errors: string[]): void {
  const prefix = `buckets[${index}]`;
  if (!isObject(bucket)) {
    errors.push(`${prefix} must be an object.`);
    return;
  }
  rejectUnknownKeys(bucket, BUCKET_KEYS, `${prefix}.`, errors);

  if (!isNonBlankString(bucket.rowKey) || bucket.rowKey.length > 128) {
    errors.push(`${prefix}.rowKey must be a non-empty string of at most 128 characters.`);
  }
  if (!isDateTimeString(bucket.bucketStart)) {
    errors.push(`${prefix}.bucketStart must be present.`);
  }
  if (bucket.bucketDurationSeconds !== EXPECTED_BUCKET_DURATION_SECONDS) {
    errors.push(
      `${prefix}.bucketDurationSeconds must be ${EXPECTED_BUCKET_DURATION_SECONDS} but was ${String(bucket.bucketDurationSeconds)}.`,
    );
  }

  validateRepository(bucket.repository, prefix, errors);
  validateRepositoryBranch(bucket.repositoryBranch, prefix, errors);

  if (!isNonBlankString(bucket.model) || bucket.model.length > 128 || !MODEL_RE.test(bucket.model)) {
    errors.push(`${prefix}.model must be a non-empty model id (letters, digits, . _ - : /) of at most 128 characters.`);
  }
  if (typeof bucket.agentMode !== 'string' || !ALLOWED_AGENT_MODES.has(bucket.agentMode)) {
    errors.push(`${prefix}.agentMode must be one of default, ask, edit, agent, custom.`);
  }
  if (typeof bucket.operation !== 'string' || !ALLOWED_OPERATIONS.has(bucket.operation)) {
    errors.push(`${prefix}.operation must be one of chat, execute_tool, execute_hook, invoke_agent.`);
  }
  if (bucket.toolName !== undefined) {
    const toolName = bucket.toolName;
    if (typeof toolName !== 'string' || toolName.length === 0 || toolName.length > 128 || !TOOL_NAME_RE.test(toolName)) {
      errors.push(`${prefix}.toolName, when present, must be an identifier (letters, digits, _ -) of at most 128 characters.`);
    }
  }

  const interactionCount = requireNonNegativeInteger(bucket.interactionCount, `${prefix}.interactionCount`, errors);
  const successCount = requireNonNegativeInteger(bucket.successCount, `${prefix}.successCount`, errors);
  const errorCount = requireNonNegativeInteger(bucket.errorCount, `${prefix}.errorCount`, errors);
  requireNonNegativeInteger(bucket.inputTokens, `${prefix}.inputTokens`, errors);
  requireNonNegativeInteger(bucket.outputTokens, `${prefix}.outputTokens`, errors);
  requireNonNegativeInteger(bucket.cachedTokens, `${prefix}.cachedTokens`, errors);
  if (bucket.reasoningTokens !== undefined) {
    requireNonNegativeInteger(bucket.reasoningTokens, `${prefix}.reasoningTokens`, errors);
  }
  if (typeof bucket.durationMsSum !== 'number' || !Number.isFinite(bucket.durationMsSum) || bucket.durationMsSum < 0) {
    errors.push(`${prefix}.durationMsSum must be >= 0.`);
  }
  requireNonNegativeInteger(bucket.distinctSessionCount, `${prefix}.distinctSessionCount`, errors);
  if (bucket.lastActivityAtMs !== undefined) {
    requireNonNegativeInteger(bucket.lastActivityAtMs, `${prefix}.lastActivityAtMs`, errors);
  }

  if (
    interactionCount !== undefined &&
    successCount !== undefined &&
    errorCount !== undefined &&
    successCount + errorCount > interactionCount
  ) {
    errors.push(`${prefix}.successCount + errorCount must be <= interactionCount.`);
  }

  validateHistogram(bucket.latencyHistogram, prefix, errors);
}

function validateHistogram(histogram: unknown, prefix: string, errors: string[]): void {
  if (!isObject(histogram)) {
    errors.push(`${prefix}.latencyHistogram is required.`);
    return;
  }
  rejectUnknownKeys(histogram, HISTOGRAM_KEYS, `${prefix}.latencyHistogram.`, errors);

  const bounds = histogram.boundsMs;
  if (!Array.isArray(bounds) || bounds.length !== CANONICAL_BOUNDS_MS.length) {
    errors.push(`${prefix}.latencyHistogram.boundsMs must have exactly ${CANONICAL_BOUNDS_MS.length} elements.`);
  } else if (bounds.some((b, i) => b !== CANONICAL_BOUNDS_MS[i])) {
    errors.push(`${prefix}.latencyHistogram.boundsMs must equal [100,250,500,1000,2000,5000,10000,30000].`);
  }

  const counts = histogram.counts;
  if (!Array.isArray(counts) || counts.length !== EXPECTED_HISTOGRAM_COUNTS_LENGTH) {
    errors.push(`${prefix}.latencyHistogram.counts must have exactly ${EXPECTED_HISTOGRAM_COUNTS_LENGTH} elements.`);
  } else if (counts.some((c) => !isNonNegativeInteger(c))) {
    errors.push(`${prefix}.latencyHistogram.counts must all be >= 0.`);
  }
}

// ── context-insights rows ────────────────────────────────────────────────────

function validateContextRow(row: unknown, index: number, errors: string[]): void {
  const prefix = `rows[${index}]`;
  if (!isObject(row)) {
    errors.push(`${prefix} must be an object.`);
    return;
  }
  rejectUnknownKeys(row, CONTEXT_ROW_KEYS, `${prefix}.`, errors);

  if (!isNonBlankString(row.rowKey) || row.rowKey.length > 128) {
    errors.push(`${prefix}.rowKey must be a non-empty string of at most 128 characters.`);
  }
  if (!isDateTimeString(row.bucketStart)) {
    errors.push(`${prefix}.bucketStart must be present.`);
  }
  if (row.bucketDurationSeconds !== EXPECTED_BUCKET_DURATION_SECONDS) {
    errors.push(
      `${prefix}.bucketDurationSeconds must be ${EXPECTED_BUCKET_DURATION_SECONDS} but was ${String(row.bucketDurationSeconds)}.`,
    );
  }

  validateRepository(row.repository, prefix, errors);
  validateContextFile(row.contextFile, prefix, errors);

  if (typeof row.category !== 'string' || !ALLOWED_CATEGORIES.has(row.category)) {
    errors.push(`${prefix}.category must be one of instruction, skill, agent, hook, prompt.`);
  }

  requireNonNegativeInteger(row.appliedCount, `${prefix}.appliedCount`, errors);
  const skippedCount = requireNonNegativeInteger(row.skippedCount, `${prefix}.skippedCount`, errors);
  requireNonNegativeInteger(row.estTokensSum, `${prefix}.estTokensSum`, errors);
  requireNonNegativeInteger(row.estTokensMax, `${prefix}.estTokensMax`, errors);
  requireNonNegativeInteger(row.sessionsWithErrorCount, `${prefix}.sessionsWithErrorCount`, errors);
  requireNonNegativeInteger(row.sessionsWithDeviationCount, `${prefix}.sessionsWithDeviationCount`, errors);
  requireNonNegativeInteger(row.distinctSessionCount, `${prefix}.distinctSessionCount`, errors);
  if (row.lastActivityAtMs !== undefined) {
    requireNonNegativeInteger(row.lastActivityAtMs, `${prefix}.lastActivityAtMs`, errors);
  }

  validateSkipReasonCounts(row.skipReasonCounts, skippedCount, prefix, errors);
}

/**
 * The privacy-critical path check: repo-relative, allowlisted customization
 * paths only. The dangerous shapes are rejected explicitly before the
 * allowlist pattern runs.
 */
function validateContextFile(contextFile: unknown, prefix: string, errors: string[]): void {
  if (typeof contextFile !== 'string' || contextFile.length === 0 || contextFile.length > 256) {
    errors.push(`${prefix}.contextFile must be a non-empty string of at most 256 characters.`);
    return;
  }
  if (
    contextFile.includes('\\') ||
    contextFile.includes(':') ||
    contextFile.startsWith('/') ||
    contextFile.includes('..') ||
    contextFile.includes('@') ||
    contextFile.includes('?') ||
    contextFile.includes('#') ||
    /\s/.test(contextFile)
  ) {
    errors.push(
      `${prefix}.contextFile must be a repo-relative POSIX path with no drive letter, leading '/', '\\', ':', '..', whitespace, '@', '?', or '#'.`,
    );
    return;
  }
  if (!CONTEXT_FILE_RE.test(contextFile)) {
    errors.push(
      `${prefix}.contextFile must be a repo-relative path ending in an allowlisted customization suffix (*.instructions.md, *.prompt.md, *.agent.md, *.skill.md) or a known root/skill file (copilot-instructions.md, AGENTS.md, CLAUDE.md, SKILL.md).`,
    );
  }
}

function validateSkipReasonCounts(counts: unknown, skippedCount: number | undefined, prefix: string, errors: string[]): void {
  if (counts === undefined) {
    return;
  }
  if (!isObject(counts)) {
    errors.push(`${prefix}.skipReasonCounts, when present, must be an object.`);
    return;
  }
  rejectUnknownKeys(counts, SKIP_REASON_KEYS, `${prefix}.skipReasonCounts.`, errors);
  let sum = 0;
  for (const key of ['applyToNoMatch', 'other'] as const) {
    const value = counts[key];
    if (value === undefined) {
      continue;
    }
    if (!isNonNegativeInteger(value)) {
      errors.push(`${prefix}.skipReasonCounts.${key} must be >= 0.`);
      continue;
    }
    sum += value;
  }
  if (skippedCount !== undefined && sum > skippedCount) {
    errors.push(`${prefix}.skipReasonCounts must sum to <= skippedCount.`);
  }
}

// ── shared field rules ───────────────────────────────────────────────────────

/** Shared by both batches and the shard's outcome rows. */
export function validateRepository(repository: unknown, prefix: string, errors: string[]): void {
  if (typeof repository !== 'string' || repository.length === 0 || repository.length > 512) {
    errors.push(`${prefix}.repository must be a non-empty string of at most 512 characters.`);
    return;
  }
  if (repository.includes('@') || repository.includes('?') || repository.includes('#') || /\s/.test(repository)) {
    errors.push(`${prefix}.repository must not contain '@', '?', '#', or whitespace (possible credential/PII leak).`);
    return;
  }
  if (!REPOSITORY_RE.test(repository)) {
    errors.push(`${prefix}.repository must be 'unknown' or a sanitized https?://host/path URL.`);
  }
}

function validateRepositoryBranch(branch: unknown, prefix: string, errors: string[]): void {
  if (branch === undefined) {
    return;
  }
  if (typeof branch !== 'string' || branch.length === 0 || branch.length > 256 || !BRANCH_RE.test(branch)) {
    errors.push(
      `${prefix}.repositoryBranch, when present, must be a git-ref-safe name (letters, digits, . _ - /) of at most 256 characters.`,
    );
  }
}

/** Any key outside `allowed` is an error — the TS spelling of `additionalProperties: false`. */
export function rejectUnknownKeys(value: Obj, allowed: ReadonlySet<string>, prefix: string, errors: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(`${prefix}${key} is not an allowed property.`);
    }
  }
}

/** Records the error and returns the value when it is a non-negative integer, else undefined. */
export function requireNonNegativeInteger(value: unknown, name: string, errors: string[]): number | undefined {
  if (!isNonNegativeInteger(value)) {
    errors.push(`${name} must be >= 0.`);
    return undefined;
  }
  return value;
}

export function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

export function isObject(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function parseDateTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

export function isDateTimeString(value: unknown): boolean {
  return parseDateTime(value) !== undefined;
}
