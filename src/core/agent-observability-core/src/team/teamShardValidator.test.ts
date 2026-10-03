import { beforeAll, describe, expect, it } from 'vitest';
import type { ValidateFunction } from 'ajv/dist/2020';
import { isUnknownShardVersion, validateTeamShard } from './teamShardValidator';
import { DEV_ID, buildFixtureShard, clone, compileShardSchema } from './teamShardFixture';

type Json = Record<string, unknown>;

function mutate(change: (copy: Json) => void): Json {
  const copy = clone(buildFixtureShard()) as unknown as Json;
  change(copy);
  return copy;
}

const OTHER_ID = `dev_${'f'.repeat(32)}`;

describe('validateTeamShard', () => {
  let validateSchema: ValidateFunction;

  beforeAll(() => {
    validateSchema = compileShardSchema();
  });

  it('accepts the fixture, with and without the expected id', () => {
    const shard = buildFixtureShard();
    expect(validateTeamShard(shard)).toEqual([]);
    expect(validateTeamShard(shard, DEV_ID)).toEqual([]);
  });

  it('rejects an envelope id that differs from the file name', () => {
    expect(validateTeamShard(buildFixtureShard(), OTHER_ID).join('\n')).toContain('does not match the file name');
  });

  it('rejects embedded batches carrying a different developer id', () => {
    const broken = mutate((c) => void ((c.aggregate as Json).pseudonymousDeveloperId = OTHER_ID));
    const errors = validateTeamShard(broken);
    expect(errors).toContain("aggregate.pseudonymousDeveloperId must equal the shard's pseudonymousDeveloperId.");
    const broken2 = mutate((c) => void ((c.contextInsights as Json).pseudonymousDeveloperId = OTHER_ID));
    expect(validateTeamShard(broken2).join('\n')).toContain('contextInsights.pseudonymousDeveloperId must equal');
  });

  it('classifies an unknown schema version separately from malformed input', () => {
    const newer = mutate((c) => void (c.schemaVersion = '2.0'));
    expect(isUnknownShardVersion(newer)).toBe(true);
    expect(isUnknownShardVersion(buildFixtureShard())).toBe(false);
    expect(isUnknownShardVersion({ broken: true })).toBe(false);
    expect(isUnknownShardVersion('2.0')).toBe(false);
    expect(validateTeamShard(newer).length).toBeGreaterThan(0);
  });

  it('rejects a window that differs from the aggregate window', () => {
    const broken = mutate((c) => void ((c.window as Json).end = '2026-06-30T00:00:00.000Z'));
    expect(validateTeamShard(broken)).toContain('window must equal aggregate.window.');
  });

  it('rejects a span wider than 90 days', () => {
    const broken = mutate((c) => {
      const end = '2026-12-01T00:00:00.000Z';
      (c.window as Json).end = end;
      ((c.aggregate as Json).window as Json).end = end;
    });
    expect(validateTeamShard(broken)).toContain('window must span at most 90 days.');
  });

  it('rejects verdict counts that do not sum to sessionCount', () => {
    const broken = mutate((c) => void (((c.outcomes as Json[])[0].verdictCounts as Json).smooth = 99));
    expect(validateTeamShard(broken)).toContain('outcomes[0].verdictCounts must sum to sessionCount.');
    expect(validateSchema(broken)).toBe(true); // the schema cannot express the sum; the validator must
  });

  it('rejects an unknown key in an outcome row or its verdict counts, as the schema does', () => {
    const extraRow = mutate((c) => void ((c.outcomes as Json[])[0].title = 'Fix the build'));
    expect(validateTeamShard(extraRow)).toContain('outcomes[0].title is not an allowed property.');
    expect(validateSchema(extraRow)).toBe(false);
    const extraVerdict = mutate((c) => void (((c.outcomes as Json[])[0].verdictCounts as Json).meh = 1));
    expect(validateTeamShard(extraVerdict).length).toBeGreaterThan(0);
    expect(validateSchema(extraVerdict)).toBe(false);
    const extraEnvelope = mutate((c) => void (c.displayName = 'Alice'));
    expect(validateTeamShard(extraEnvelope)).toContain('displayName is not an allowed property.');
    expect(validateSchema(extraEnvelope)).toBe(false);
  });

  it('rejects bad outcome fields on both sides', () => {
    const cases: ((c: Json) => void)[] = [
      (c) => void ((c.outcomes as Json[])[0].source = 'gemini'),
      (c) => void ((c.outcomes as Json[])[0].costMode = 'eur'),
      (c) => void ((c.outcomes as Json[])[0].day = '2026-6-1'),
      (c) => void ((c.outcomes as Json[])[0].rowKey = 'abc'),
      (c) => void ((c.outcomes as Json[])[0].repository = 'https://u:t@github.com/a/b'),
      (c) => void ((c.outcomes as Json[])[0].costMicros = -1),
    ];
    for (const change of cases) {
      const broken = mutate(change);
      expect(validateTeamShard(broken).length).toBeGreaterThan(0);
      expect(validateSchema(broken)).toBe(false);
    }
  });

  it('rejects pricedSessionCount above sessionCount', () => {
    const broken = mutate((c) => void ((c.outcomes as Json[])[0].pricedSessionCount = 50));
    expect(validateTeamShard(broken)).toContain('outcomes[0].pricedSessionCount must be <= sessionCount.');
  });

  it('rejects non-objects and missing outcomes', () => {
    expect(validateTeamShard('nope')).toEqual(['shard must be a JSON object.']);
    const noOutcomes = mutate((c) => void delete c.outcomes);
    expect(validateTeamShard(noOutcomes)).toContain('outcomes is required (an empty array is valid).');
  });
});
