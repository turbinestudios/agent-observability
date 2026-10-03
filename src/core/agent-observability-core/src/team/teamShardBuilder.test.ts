import { describe, expect, it } from 'vitest';
import { TEAM_SHARD_MAX_WINDOW_DAYS } from './teamShardModels';
import { buildOutcomeRows, clampTeamWindow, computeOutcomeRowKey, utcDay } from './teamShardBuilder';
import { DEV_ID, OTHER_REPO, REPO, T0, WINDOW_END, WINDOW_START, buildFixtureShard, outcomes } from './teamShardFixture';

const DAY = 86_400_000;

describe('utcDay', () => {
  it('buckets by UTC regardless of the machine zone', () => {
    expect(utcDay(Date.UTC(2026, 5, 1, 23, 30))).toBe('2026-06-01');
    expect(utcDay(Date.UTC(2026, 5, 2, 0, 0))).toBe('2026-06-02');
    expect(utcDay(Date.UTC(2026, 11, 31, 23, 59, 59))).toBe('2026-12-31');
  });
});

describe('clampTeamWindow', () => {
  it('caps the span at the maximum by moving start forward', () => {
    const end = T0 + 200 * DAY;
    const clamped = clampTeamWindow(T0, end);
    expect(clamped.endMs).toBe(end);
    expect(clamped.endMs - clamped.startMs).toBe(TEAM_SHARD_MAX_WINDOW_DAYS * DAY);
  });

  it('leaves a short window alone and repairs an inverted one', () => {
    expect(clampTeamWindow(T0, T0 + DAY)).toEqual({ startMs: T0, endMs: T0 + DAY });
    expect(clampTeamWindow(T0 + DAY, T0)).toEqual({ startMs: T0 - 1, endMs: T0 });
  });
});

describe('buildOutcomeRows', () => {
  const rows = buildOutcomeRows(outcomes(), DEV_ID, WINDOW_START, WINDOW_END);

  it('groups by UTC day, repository and source in a deterministic order', () => {
    expect(rows.map((r) => [r.day, r.repository, r.source])).toEqual([
      ['2026-06-01', REPO, 'claude'],
      ['2026-06-02', REPO, 'claude'],
      ['2026-06-02', OTHER_REPO, 'copilot'],
    ]);
  });

  it('puts a 23:30 UTC session on its own UTC day', () => {
    const late = rows.find((r) => r.day === '2026-06-02' && r.repository === REPO);
    expect(late?.sessionCount).toBe(1);
    expect(late?.verdictCounts.unjudged).toBe(1);
  });

  it('sums verdict counts to sessionCount and prices only priced sessions', () => {
    const first = rows[0];
    expect(first.sessionCount).toBe(2);
    expect(first.verdictCounts).toEqual({ smooth: 1, bumpy: 0, struggled: 1, abandoned: 0, unjudged: 0 });
    expect(first.pricedSessionCount).toBe(1);
    expect(first.costMicros).toBe(120_000);
    expect(first.costMode).toBe('usd');
    for (const row of rows) {
      const sum = Object.values(row.verdictCounts).reduce((a, b) => a + b, 0);
      expect(sum).toBe(row.sessionCount);
      expect(row.pricedSessionCount).toBeLessThanOrEqual(row.sessionCount);
    }
  });

  it('drops unknown sources, unsafe repositories and out-of-window sessions', () => {
    expect(rows.some((r) => r.source !== 'claude' && r.source !== 'copilot')).toBe(false);
    expect(rows.some((r) => r.repository.includes('@') || r.repository.includes('\\'))).toBe(false);
    const total = rows.reduce((n, r) => n + r.sessionCount, 0);
    expect(total).toBe(4);
  });

  it('derives rowKey from devId|day|repository|source and is stable across rebuilds', () => {
    expect(rows[0].rowKey).toBe(computeOutcomeRowKey(DEV_ID, '2026-06-01', REPO, 'claude'));
    expect(rows[0].rowKey).toMatch(/^[0-9a-f]{64}$/);
    const again = buildOutcomeRows(outcomes(), DEV_ID, WINDOW_START, WINDOW_END);
    expect(again).toEqual(rows);
  });
});

describe('buildTeamShard', () => {
  const shard = buildFixtureShard();

  it('embeds the two batches with the same developer id and an equal window', () => {
    expect(shard.schemaVersion).toBe('1.0');
    expect(shard.pseudonymousDeveloperId).toBe(DEV_ID);
    expect(shard.aggregate.pseudonymousDeveloperId).toBe(DEV_ID);
    expect(shard.contextInsights.pseudonymousDeveloperId).toBe(DEV_ID);
    expect(shard.window).toEqual(shard.aggregate.window);
    expect(shard.window).toEqual(shard.contextInsights.window);
    expect(shard.aggregate.buckets.length).toBeGreaterThan(0);
    expect(shard.contextInsights.rows.length).toBeGreaterThan(0);
    expect(shard.outcomes).toHaveLength(3);
  });

  it('is byte-identical on rebuild except the generatedAt stamps', () => {
    const again = buildFixtureShard(T0 + 9 * DAY);
    const strip = (s: typeof shard): unknown => ({
      ...s,
      generatedAt: undefined,
      aggregate: { ...s.aggregate, generatedAt: undefined },
      contextInsights: { ...s.contextInsights, generatedAt: undefined },
    });
    expect(strip(again)).toEqual(strip(shard));
    expect(again.generatedAt).not.toBe(shard.generatedAt);
  });
});
