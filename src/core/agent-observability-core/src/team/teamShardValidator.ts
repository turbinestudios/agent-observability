import {
  isNonNegativeInteger,
  isObject,
  parseDateTime,
  rejectUnknownKeys,
  requireNonNegativeInteger,
  schemaVersionOf,
  validateAggregateBatch,
  validateContextInsightsBatch,
  validateRepository,
  validateWindow,
} from '../aggregate/batchValidators';
import {
  OUTCOME_COST_MODES,
  OUTCOME_DAY_PATTERN,
  OUTCOME_SOURCES,
  OUTCOME_VERDICTS,
  TEAM_SHARD_MAX_WINDOW_DAYS,
  TEAM_SHARD_SCHEMA_VERSION,
} from './teamShardModels';

/**
 * Validates a team shard read from the shared folder BEFORE it is merged. The
 * folder is written by other machines, so nothing in it is trusted: the
 * envelope and the `outcomes` block are checked here, and the two embedded
 * batches go through the same TS ports of the dashboard's validators an HTTP
 * upload would face. Anything that fails is skipped with a notice, never
 * partially merged.
 */

const ENVELOPE_KEYS = new Set([
  'schemaVersion',
  'generatedAt',
  'toolVersion',
  'pseudonymousDeveloperId',
  'window',
  'aggregate',
  'contextInsights',
  'outcomes',
]);
const OUTCOME_KEYS = new Set([
  'rowKey',
  'day',
  'repository',
  'source',
  'sessionCount',
  'verdictCounts',
  'costMicros',
  'pricedSessionCount',
  'costMode',
]);
const VERDICT_KEYS: ReadonlySet<string> = new Set(OUTCOME_VERDICTS);
const SOURCES: ReadonlySet<string> = new Set(OUTCOME_SOURCES);
const COST_MODES: ReadonlySet<string> = new Set(OUTCOME_COST_MODES);

const DEVELOPER_ID_RE = /^dev_[0-9a-f]{32}$/;
const TOOL_VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const ROW_KEY_RE = /^[0-9a-f]{64}$/;
const DAY_MS = 86_400_000;

/** An object whose `schemaVersion` is a string other than the one we know. */
export function isUnknownShardVersion(value: unknown): boolean {
  const version = schemaVersionOf(value);
  return version !== undefined && version !== TEAM_SHARD_SCHEMA_VERSION;
}

/**
 * `[]` when valid; otherwise one message per problem. `expectedDeveloperId`
 * (the id the file name promises) must match the envelope when given.
 */
export function validateTeamShard(value: unknown, expectedDeveloperId?: string): string[] {
  const errors: string[] = [];
  if (!isObject(value)) {
    return ['shard must be a JSON object.'];
  }
  rejectUnknownKeys(value, ENVELOPE_KEYS, '', errors);

  if (value.schemaVersion !== TEAM_SHARD_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be '${TEAM_SHARD_SCHEMA_VERSION}' but was '${String(value.schemaVersion)}'.`);
  }
  if (parseDateTime(value.generatedAt) === undefined) {
    errors.push('generatedAt must be an ISO 8601 date-time.');
  }
  if (typeof value.toolVersion !== 'string' || value.toolVersion.length > 64 || !TOOL_VERSION_RE.test(value.toolVersion)) {
    errors.push("toolVersion must be a semantic version (e.g. '1.17.0') of at most 64 characters.");
  }

  const developerId = value.pseudonymousDeveloperId;
  if (typeof developerId !== 'string' || !DEVELOPER_ID_RE.test(developerId)) {
    errors.push('pseudonymousDeveloperId must match ^dev_[0-9a-f]{32}$.');
  } else if (expectedDeveloperId !== undefined && developerId !== expectedDeveloperId) {
    errors.push(`pseudonymousDeveloperId '${developerId}' does not match the file name's '${expectedDeveloperId}'.`);
  }

  validateWindow(value.window, errors);
  if (isObject(value.window)) {
    const start = parseDateTime(value.window.start);
    const end = parseDateTime(value.window.end);
    if (start !== undefined && end !== undefined && end - start > TEAM_SHARD_MAX_WINDOW_DAYS * DAY_MS) {
      errors.push(`window must span at most ${TEAM_SHARD_MAX_WINDOW_DAYS} days.`);
    }
  }

  // The embedded batches: exactly the server's rules, prefixed so a reader
  // knows which part failed.
  for (const message of validateAggregateBatch(value.aggregate)) {
    errors.push(`aggregate: ${message}`);
  }
  for (const message of validateContextInsightsBatch(value.contextInsights)) {
    errors.push(`contextInsights: ${message}`);
  }

  // The three ids and the two windows must agree.
  if (typeof developerId === 'string') {
    for (const part of ['aggregate', 'contextInsights'] as const) {
      const batch = value[part];
      if (isObject(batch) && batch.pseudonymousDeveloperId !== developerId) {
        errors.push(`${part}.pseudonymousDeveloperId must equal the shard's pseudonymousDeveloperId.`);
      }
    }
  }
  if (isObject(value.window) && isObject(value.aggregate) && isObject(value.aggregate.window)) {
    const shardStart = parseDateTime(value.window.start);
    const shardEnd = parseDateTime(value.window.end);
    const batchStart = parseDateTime(value.aggregate.window.start);
    const batchEnd = parseDateTime(value.aggregate.window.end);
    if (
      shardStart !== undefined &&
      shardEnd !== undefined &&
      batchStart !== undefined &&
      batchEnd !== undefined &&
      (shardStart !== batchStart || shardEnd !== batchEnd)
    ) {
      errors.push('window must equal aggregate.window.');
    }
  }

  if (!Array.isArray(value.outcomes)) {
    errors.push('outcomes is required (an empty array is valid).');
    return errors;
  }
  value.outcomes.forEach((row, i) => validateOutcomeRow(row, i, errors));
  return errors;
}

function validateOutcomeRow(row: unknown, index: number, errors: string[]): void {
  const prefix = `outcomes[${index}]`;
  if (!isObject(row)) {
    errors.push(`${prefix} must be an object.`);
    return;
  }
  rejectUnknownKeys(row, OUTCOME_KEYS, `${prefix}.`, errors);

  if (typeof row.rowKey !== 'string' || !ROW_KEY_RE.test(row.rowKey)) {
    errors.push(`${prefix}.rowKey must be 64 lowercase hex characters.`);
  }
  if (typeof row.day !== 'string' || !OUTCOME_DAY_PATTERN.test(row.day)) {
    errors.push(`${prefix}.day must be a UTC calendar day (YYYY-MM-DD).`);
  }
  validateRepository(row.repository, prefix, errors);
  if (typeof row.source !== 'string' || !SOURCES.has(row.source)) {
    errors.push(`${prefix}.source must be one of claude, copilot.`);
  }
  if (typeof row.costMode !== 'string' || !COST_MODES.has(row.costMode)) {
    errors.push(`${prefix}.costMode must be one of usd, aiu, credits.`);
  }

  const sessionCount = requireNonNegativeInteger(row.sessionCount, `${prefix}.sessionCount`, errors);
  requireNonNegativeInteger(row.costMicros, `${prefix}.costMicros`, errors);
  const priced = requireNonNegativeInteger(row.pricedSessionCount, `${prefix}.pricedSessionCount`, errors);
  if (sessionCount !== undefined && priced !== undefined && priced > sessionCount) {
    errors.push(`${prefix}.pricedSessionCount must be <= sessionCount.`);
  }

  const counts = row.verdictCounts;
  if (!isObject(counts)) {
    errors.push(`${prefix}.verdictCounts is required.`);
    return;
  }
  rejectUnknownKeys(counts, VERDICT_KEYS, `${prefix}.verdictCounts.`, errors);
  let sum = 0;
  let complete = true;
  for (const verdict of OUTCOME_VERDICTS) {
    const count = counts[verdict];
    if (!isNonNegativeInteger(count)) {
      errors.push(`${prefix}.verdictCounts.${verdict} must be an integer >= 0.`);
      complete = false;
      continue;
    }
    sum += count;
  }
  if (complete && sessionCount !== undefined && sum !== sessionCount) {
    errors.push(`${prefix}.verdictCounts must sum to sessionCount.`);
  }
}
