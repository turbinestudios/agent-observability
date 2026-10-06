import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020';
import type { ValidateFunction } from 'ajv/dist/2020';
import type { AggregationRow } from '../aggregate/aggregator';
import type { ContextFileObservation } from '../aggregate/contextInsightsExtractor';
import { computeDeveloperId } from '../aggregate/pseudonymizer';
import { AGGREGATE_SCHEMA, CONTEXT_INSIGHTS_SCHEMA } from '../telemetry/testSupport';
import { buildTeamShard, type OutcomeInput } from './teamShardBuilder';
import type { TeamShard } from './teamShardModels';

/**
 * Test-only fixtures shared by the shard builder, validator and privacy tests.
 * Deterministic: a fixed salt, fixed UTC anchor, no machine-dependent values.
 */

export const SALT = 'c'.repeat(64);
export const DEV_ID = computeDeveloperId(SALT, 'tester@example.com');
export const REPO = 'https://github.com/acme/widgets';
export const OTHER_REPO = 'https://gitlab.example.com/team/service';

/** A fixed anchor: 2026-06-01T00:00:00Z. */
export const T0 = Date.UTC(2026, 5, 1, 0, 0, 0);
export const WINDOW_START = T0;
export const WINDOW_END = T0 + 7 * 86_400_000;
export const GENERATED_AT = T0 + 8 * 86_400_000;

export const PLANTED_TITLE = 'Refactor the billing adapter for Globex';

export const TEAM_SHARD_SCHEMA = path.resolve(path.dirname(AGGREGATE_SCHEMA), 'team-shard.schema.json');

export function aggregationRows(): AggregationRow[] {
  return [
    {
      startTimeMs: T0 + 3_600_000,
      sessionKey: 'sess-A',
      repository: REPO,
      model: 'claude-opus-4.6',
      agentMode: 'agent',
      operation: 'chat',
      durationMs: 1_200,
      statusCode: 1,
      inputTokens: 1_000,
      outputTokens: 200,
      cachedTokens: 50,
    },
    {
      startTimeMs: T0 + 3_700_000,
      sessionKey: 'sess-A',
      repository: REPO,
      model: 'claude-opus-4.6',
      agentMode: 'agent',
      operation: 'execute_tool',
      toolName: 'read_file',
      durationMs: 300,
      statusCode: 2,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    },
    {
      startTimeMs: T0 + 86_400_000 + 60_000,
      sessionKey: 'sess-B',
      repository: OTHER_REPO,
      model: 'gpt-4o',
      agentMode: 'ask',
      operation: 'chat',
      durationMs: 800,
      statusCode: 1,
      inputTokens: 500,
      outputTokens: 100,
      cachedTokens: 0,
    },
  ];
}

export function observations(): ContextFileObservation[] {
  return [
    {
      startTimeMs: T0 + 3_600_000,
      sessionKey: 'sess-A',
      repository: REPO,
      contextFile: 'AGENTS.md',
      category: 'agent',
      applied: true,
      estTokens: 400,
      hadError: true,
      hadDeviation: false,
    },
    {
      startTimeMs: T0 + 3_600_000,
      sessionKey: 'sess-A',
      repository: REPO,
      contextFile: '.github/instructions/security.instructions.md',
      category: 'instruction',
      applied: false,
      estTokens: 0,
      skipReason: 'applyToNoMatch',
      hadError: true,
      hadDeviation: false,
    },
  ];
}

/** Honest inputs plus adversarial rows that MUST be dropped by the builder. */
export function outcomes(): OutcomeInput[] {
  return [
    { endedAtMs: T0 + 3_700_000, repository: REPO, source: 'claude', verdict: 'smooth', costMicros: 120_000, costMode: 'usd' },
    { endedAtMs: T0 + 5_000_000, repository: REPO, source: 'claude', verdict: 'struggled', costMicros: undefined, costMode: 'usd' },
    // 23:30 UTC on day 1 stays on day 1 regardless of the machine zone.
    { endedAtMs: T0 + 86_400_000 + 23.5 * 3_600_000, repository: REPO, source: 'claude', verdict: undefined, costMicros: 30_000, costMode: 'usd' },
    { endedAtMs: T0 + 86_400_000 + 60_000, repository: OTHER_REPO, source: 'copilot', verdict: 'bumpy', costMicros: 5_000, costMode: 'aiu' },
    // Adversarial: credential-bearing remote, absolute path, email, title, unknown source, outside window.
    { endedAtMs: T0 + 10_000, repository: 'https://user:token@github.com/acme/widgets', source: 'claude', verdict: 'smooth', costMicros: 1, costMode: 'usd' },
    { endedAtMs: T0 + 10_000, repository: 'C:\\Users\\jdoe\\repos\\widgets', source: 'claude', verdict: 'smooth', costMicros: 1, costMode: 'usd' },
    { endedAtMs: T0 + 10_000, repository: 'jdoe@example.com', source: 'claude', verdict: 'smooth', costMicros: 1, costMode: 'usd' },
    { endedAtMs: T0 + 10_000, repository: PLANTED_TITLE, source: 'claude', verdict: 'smooth', costMicros: 1, costMode: 'usd' },
    { endedAtMs: T0 + 10_000, repository: REPO, source: 'copilot-cloud', verdict: 'smooth', costMicros: 1, costMode: 'usd' },
    { endedAtMs: WINDOW_END, repository: REPO, source: 'claude', verdict: 'smooth', costMicros: 1, costMode: 'usd' },
    { endedAtMs: WINDOW_START - 1, repository: REPO, source: 'claude', verdict: 'smooth', costMicros: 1, costMode: 'usd' },
  ];
}

export function buildFixtureShard(generatedAtMs: number = GENERATED_AT): TeamShard {
  return buildTeamShard({
    rows: aggregationRows(),
    observations: observations(),
    outcomes: outcomes(),
    pseudonymousDeveloperId: DEV_ID,
    toolVersion: '1.17.0',
    windowStartMs: WINDOW_START,
    windowEndMs: WINDOW_END,
    generatedAtMs,
  });
}

/** ajv 2020, strict, with the two referenced schemas registered by `$id`. */
export function compileShardSchema(): ValidateFunction {
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  ajv.addFormat('date-time', true);
  ajv.addSchema(JSON.parse(readFileSync(AGGREGATE_SCHEMA, 'utf8')) as object);
  ajv.addSchema(JSON.parse(readFileSync(CONTEXT_INSIGHTS_SCHEMA, 'utf8')) as object);
  return ajv.compile(JSON.parse(readFileSync(TEAM_SHARD_SCHEMA, 'utf8')) as object);
}

/** Collect every string value (and key) reachable in an arbitrary JSON value. */
export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) {
      collectStrings(v, out);
    }
  } else if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      collectStrings(v, out);
    }
  }
  return out;
}

/** Deep clone through JSON so a test can mutate a copy of the fixture. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
