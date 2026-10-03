import { beforeAll, describe, expect, it } from 'vitest';
import type { ValidateFunction } from 'ajv/dist/2020';
import { REPOSITORY_PATTERN } from '../telemetry/repositoryUrl';
import { SAFE_CONTEXT_FILE_PATTERN } from '../aggregate/customizationFilter';
import type { TeamShard } from './teamShardModels';
import { validateTeamShard } from './teamShardValidator';
import { DEV_ID, PLANTED_TITLE, T0, buildFixtureShard, collectStrings, compileShardSchema } from './teamShardFixture';

/**
 * CRITICAL privacy regression test for the team shard — the only artifact the
 * desktop app writes outside the machine.
 *
 * Builds a real shard from an adversarial fixture (credential-bearing remote,
 * absolute path, email, a planted session title, an unknown source) and proves:
 *  (1) it validates against the strict schema with ajv, the two embedded
 *      contracts resolved by `$ref`, so `additionalProperties:false` holds
 *      everywhere;
 *  (2) no string anywhere carries a raw-content marker, an email shape, '@',
 *      a backslash, a drive letter, a home directory or the planted title;
 *  (3) every repository and contextFile matches the contracts' patterns and
 *      the three developer ids are pseudonymous and equal;
 *  (4) rebuilding is byte-identical except generatedAt (idempotency);
 *  (5) the TS validator the importer uses accepts it.
 */

const RAW_CONTENT_MARKERS = [
  'copilot_chat.user_request',
  'gen_ai.input.messages',
  'gen_ai.output.messages',
  'gen_ai.system_instructions',
  'gen_ai.tool.call.arguments',
  'gen_ai.tool.call.result',
  'gen_ai.tool.definitions',
  'gen_ai.tool.description',
  'copilot_chat.reasoning_content',
  'copilot_chat.hook_input',
  'copilot_chat.hook_output',
  'copilot_chat.hook_command',
  'copilot_chat.request.options',
  'copilot_chat.repo.head_branch_name',
  'copilot_chat.repo.head_commit_hash',
  'repositoryBranch',
  'title',
  'prompt',
  'branch',
];
const REDACTION_PLACEHOLDER = '[redacted';
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const DRIVE_LETTER = /(?:^|[^A-Za-z])[A-Za-z]:[\\/]/;

describe('team shard privacy contract (adversarial fixture)', () => {
  let shard: TeamShard;
  let json: string;
  let strings: string[];
  let validate: ValidateFunction;

  beforeAll(() => {
    shard = buildFixtureShard();
    json = JSON.stringify(shard);
    strings = collectStrings(JSON.parse(json));
    validate = compileShardSchema();
  });

  it('(1) validates against the strict schema with the embedded contracts resolved by $ref', () => {
    const ok = validate(JSON.parse(json));
    if (!ok) {
      throw new Error(`schema validation failed: ${JSON.stringify(validate.errors)}`);
    }
    expect(ok).toBe(true);
  });

  it('(2) carries no raw-content marker, email, @, backslash, drive letter, home dir or planted title', () => {
    for (const s of strings) {
      for (const marker of RAW_CONTENT_MARKERS) {
        expect(s.toLowerCase(), `marker ${marker} in ${s}`).not.toContain(marker.toLowerCase());
      }
      expect(s).not.toContain(REDACTION_PLACEHOLDER);
      expect(s, `email shape in ${s}`).not.toMatch(EMAIL_SHAPE);
      expect(s, `@ in ${s}`).not.toContain('@');
      expect(s, `backslash in ${s}`).not.toContain('\\');
      expect(s, `drive letter in ${s}`).not.toMatch(DRIVE_LETTER);
      expect(s).not.toContain('/home/');
      expect(s).not.toContain('/Users/');
      expect(s).not.toContain('jdoe');
      expect(s).not.toContain(PLANTED_TITLE);
      expect(s).not.toContain('Globex');
    }
  });

  it('(3) every repository and contextFile matches the contracts, and the ids are pseudonymous and equal', () => {
    for (const row of shard.outcomes) {
      expect(row.repository).toMatch(REPOSITORY_PATTERN);
    }
    for (const bucket of shard.aggregate.buckets) {
      expect(bucket.repository).toMatch(REPOSITORY_PATTERN);
    }
    for (const row of shard.contextInsights.rows) {
      expect(row.repository).toMatch(REPOSITORY_PATTERN);
      expect(row.contextFile).toMatch(SAFE_CONTEXT_FILE_PATTERN);
    }
    expect(shard.pseudonymousDeveloperId).toMatch(/^dev_[0-9a-f]{32}$/);
    expect(shard.aggregate.pseudonymousDeveloperId).toBe(shard.pseudonymousDeveloperId);
    expect(shard.contextInsights.pseudonymousDeveloperId).toBe(shard.pseudonymousDeveloperId);
    expect(shard.pseudonymousDeveloperId).toBe(DEV_ID);
    // The salt and the raw identity never appear.
    expect(json).not.toContain('c'.repeat(64));
    expect(json).not.toContain('tester');
  });

  it('(4) rebuilds byte-identically except the generatedAt stamps', () => {
    const again = buildFixtureShard(T0 + 20 * 86_400_000);
    const scrub = (s: string): string => s.replace(/"generatedAt":"[^"]+"/g, '"generatedAt":"X"');
    expect(scrub(JSON.stringify(again))).toBe(scrub(json));
  });

  it('(5) the importer-side TS validator accepts it, with the file-name id', () => {
    expect(validateTeamShard(JSON.parse(json), DEV_ID)).toEqual([]);
  });
});
