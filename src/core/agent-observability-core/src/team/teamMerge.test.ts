import { describe, expect, it } from 'vitest';
import { mergeShards } from './teamMerge';
import type { TeamShard } from './teamShardModels';

const ID_A = `dev_${'a'.repeat(32)}`;
const ID_B = `dev_${'b'.repeat(32)}`;

function shard(id: string, generatedAt: string, outcomeDays: string[] = []): TeamShard {
  return {
    schemaVersion: '1.0',
    generatedAt,
    toolVersion: '1.17.0',
    pseudonymousDeveloperId: id,
    window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
    aggregate: {
      schemaVersion: '1.0',
      batchId: 'b',
      generatedAt,
      toolVersion: '1.17.0',
      pseudonymousDeveloperId: id,
      window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      buckets: [],
    },
    contextInsights: {
      schemaVersion: '1.0',
      batchId: 'c',
      generatedAt,
      toolVersion: '1.17.0',
      pseudonymousDeveloperId: id,
      window: { start: '2026-09-01T00:00:00.000Z', end: '2026-10-01T00:00:00.000Z' },
      rows: [],
    },
    outcomes: outcomeDays.map((day) => ({
      rowKey: `${id}-${day}`,
      day,
      repository: 'https://github.com/o/r',
      source: 'claude',
      sessionCount: 1,
      verdictCounts: { smooth: 1, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0 },
      costMicros: 0,
      pricedSessionCount: 0,
      costMode: 'usd',
    })),
  };
}

describe('mergeShards', () => {
  it('keeps one shard per member and lets the newest generatedAt win', () => {
    const older = shard(ID_A, '2026-09-20T10:00:00.000Z', ['2026-09-19']);
    const newer = shard(ID_A, '2026-09-25T10:00:00.000Z', ['2026-09-24']);
    const { members, problems } = mergeShards([
      { fileName: `${ID_A}.json`, shard: older },
      { fileName: `${ID_A}.json`, shard: newer },
      { fileName: `${ID_B}.json`, shard: shard(ID_B, '2026-09-21T00:00:00.000Z') },
    ]);
    expect(problems).toEqual([]);
    expect([...members.keys()].sort()).toEqual([ID_A, ID_B]);
    expect(members.get(ID_A)?.outcomes.map((o) => o.day)).toEqual(['2026-09-24']);
  });

  it('never resurrects rows from a stale duplicate, whichever order the files arrive in', () => {
    const older = shard(ID_A, '2026-09-20T10:00:00.000Z', ['2026-09-19']);
    const newer = shard(ID_A, '2026-09-25T10:00:00.000Z', ['2026-09-24']);
    const { members } = mergeShards([
      { fileName: `${ID_A}.json`, shard: newer },
      { fileName: `${ID_A}.json`, shard: older },
    ]);
    expect(members.get(ID_A)?.outcomes.map((o) => o.day)).toEqual(['2026-09-24']);
  });

  it('refuses a file whose name does not match the id inside it', () => {
    const { members, problems } = mergeShards([{ fileName: `${ID_B}.json`, shard: shard(ID_A, '2026-09-20T00:00:00.000Z') }]);
    expect(members.size).toBe(0);
    expect(problems).toEqual([
      { fileName: `${ID_B}.json`, reason: 'id-mismatch', detail: expect.stringContaining('does not match') },
    ]);
  });

  it('treats an unparsable generatedAt as the oldest possible', () => {
    const broken = shard(ID_A, 'yesterday-ish', ['2026-09-01']);
    const dated = shard(ID_A, '2026-09-02T00:00:00.000Z', ['2026-09-02']);
    const { members } = mergeShards([
      { fileName: `${ID_A}.json`, shard: dated },
      { fileName: `${ID_A}.json`, shard: broken },
    ]);
    expect(members.get(ID_A)?.outcomes[0].day).toBe('2026-09-02');
  });
});
