import type { AggregateBatch } from '../aggregate/models';
import type { ContextInsightsBatch } from '../aggregate/contextInsightsModels';

/**
 * The team shard: one JSON file per member in a folder the team shares, the
 * desktop app's only way of moving anything between machines.
 *
 * It EMBEDS the two existing upload contracts unchanged — the aggregate batch
 * and the context-insights batch, built by the same core builders the VS Code
 * extension uses — and adds exactly one new block, `outcomes`: per UTC day,
 * repository and source, how many sessions ran, how they went (verdict
 * counts) and their estimated cost. Counts and closed-set labels only; never
 * a title, a prompt, a path beyond the already-sanctioned repo-relative
 * context-file names, or a name of any kind.
 *
 * Keep these types in lockstep with `schemas/team-shard.schema.json`, exactly
 * as `aggregate/models.ts` tracks its schema. The schema is the contract; the
 * types are its TypeScript shadow.
 */

export const TEAM_SHARD_SCHEMA_VERSION = '1.0';

/** Longest window a producer may export; the importer rejects wider shards. */
export const TEAM_SHARD_MAX_WINDOW_DAYS = 90;

/** Files larger than this are skipped before parsing. */
export const TEAM_SHARD_MAX_BYTES = 16 * 1024 * 1024;

/** A shard file is named after the member it belongs to, and nothing else is read. */
export const TEAM_SHARD_FILE_PATTERN = /^dev_[0-9a-f]{32}\.json$/;

/** The producer rewrites its shard through a sibling temp file; readers ignore it. */
export const TEAM_SHARD_TEMP_SUFFIX = '.tmp';

/**
 * The sources a shard may name. `copilot-cli` covers terminal Copilot sessions
 * AND the ones the app hosts through Run, which are stored as Copilot CLI
 * sessions. Widened before the first release that reads shards, so the
 * contract version did not need to change; from the first tagged release on,
 * adding a value here is a schema version bump.
 */
export const OUTCOME_SOURCES = ['claude', 'copilot', 'copilot-cli'] as const;
export type OutcomeSource = (typeof OUTCOME_SOURCES)[number];

export const OUTCOME_COST_MODES = ['usd', 'aiu', 'credits'] as const;
export type OutcomeCostMode = (typeof OUTCOME_COST_MODES)[number];

export const OUTCOME_VERDICTS = ['smooth', 'bumpy', 'struggled', 'abandoned', 'unjudged'] as const;
export type OutcomeVerdict = (typeof OUTCOME_VERDICTS)[number];

export type VerdictCounts = Record<OutcomeVerdict, number>;

/** `YYYY-MM-DD`, UTC. Producers bucket; importers never re-bin. */
export const OUTCOME_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface OutcomeRow {
  /** sha256 hex of `devId|day|repository|source`; the idempotent merge key. */
  rowKey: string;
  /** UTC calendar day of the sessions' end time. */
  day: string;
  /** Sanitized `https://host/owner/repo`, or `unknown` — the batches' pattern. */
  repository: string;
  source: OutcomeSource;
  sessionCount: number;
  /** Sums to `sessionCount` by construction. */
  verdictCounts: VerdictCounts;
  /** Integer micro-USD over the PRICED sessions only. */
  costMicros: number;
  /** How many of `sessionCount` carry a cost estimate — the honesty denominator. */
  pricedSessionCount: number;
  /** The source's billing basis, so mixed-basis totals stay visible. */
  costMode: OutcomeCostMode;
}

export interface TeamShard {
  schemaVersion: typeof TEAM_SHARD_SCHEMA_VERSION;
  /** Producer clock, RFC 3339 UTC. Informational, plus the stale indicator. */
  generatedAt: string;
  /** Semver of the app that wrote the shard. */
  toolVersion: string;
  pseudonymousDeveloperId: string;
  /** Closed-open UTC window, equal to `aggregate.window`. */
  window: { start: string; end: string };
  /** The unchanged aggregate-batch v1.0 contract. */
  aggregate: AggregateBatch;
  /** The unchanged context-insights v1.0 contract. */
  contextInsights: ContextInsightsBatch;
  outcomes: OutcomeRow[];
}

/** Why a file in the team folder was not merged. Always shown, never silent. */
export type ShardProblemReason = 'unknown-schema-version' | 'invalid' | 'id-mismatch' | 'too-large' | 'unreadable';

export interface ShardProblem {
  fileName: string;
  reason: ShardProblemReason;
  detail?: string;
}

export function emptyVerdictCounts(): VerdictCounts {
  return { smooth: 0, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0 };
}
