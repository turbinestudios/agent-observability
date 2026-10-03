import { describe, expect, it } from 'vitest';
import type { AggregateBucket } from '../aggregate/models';
import type { ContextFileRow } from '../aggregate/contextInsightsModels';
import type { MergedTeam } from './teamMerge';
import { computeTeamMetrics, utcDayString, windowDays } from './teamMetrics';
import type { OutcomeRow, TeamShard, VerdictCounts } from './teamShardModels';
import { TEAM_STALE_MS, TEAM_STALE_TOLERANCE_MS } from './teamViewModels';

const ME = `dev_${'1'.repeat(32)}`;
const PEER = `dev_${'2'.repeat(32)}`;
const THIRD = `dev_${'3'.repeat(32)}`;
const TODAY = '2026-10-03';
const NOW = Date.UTC(2026, 9, 3, 12);
const REPO = 'https://github.com/o/repo';

function verdicts(over: Partial<VerdictCounts> = {}): VerdictCounts {
  return { smooth: 0, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0, ...over };
}

function outcome(day: string, over: Partial<OutcomeRow> = {}): OutcomeRow {
  const sessionCount = over.sessionCount ?? 1;
  return {
    rowKey: `${day}-${over.repository ?? REPO}-${over.source ?? 'claude'}`,
    day,
    repository: REPO,
    source: 'claude',
    sessionCount,
    verdictCounts: over.verdictCounts ?? verdicts({ smooth: sessionCount }),
    costMicros: 0,
    pricedSessionCount: sessionCount,
    costMode: 'usd',
    ...over,
  };
}

function bucket(bucketStart: string, inputTokens: number, outputTokens = 0): AggregateBucket {
  return {
    rowKey: bucketStart,
    bucketStart,
    bucketDurationSeconds: 1800,
    repository: REPO,
    model: 'claude-opus',
    agentMode: 'agent',
    operation: 'chat',
    interactionCount: 1,
    successCount: 1,
    errorCount: 0,
    inputTokens,
    outputTokens,
    cachedTokens: 0,
    durationMsSum: 1,
    latencyHistogram: { boundsMs: [100, 250, 500, 1000, 2000, 5000, 10000, 30000], counts: [1, 0, 0, 0, 0, 0, 0, 0, 0] },
    // Deliberately large: the metrics must never sum this across buckets.
    distinctSessionCount: 99,
  };
}

function contextRow(bucketStart: string, over: Partial<ContextFileRow> = {}): ContextFileRow {
  return {
    rowKey: `${bucketStart}-${over.contextFile ?? 'AGENTS.md'}`,
    bucketStart,
    bucketDurationSeconds: 1800,
    repository: REPO,
    contextFile: 'AGENTS.md',
    category: 'instruction',
    appliedCount: 1,
    skippedCount: 0,
    estTokensSum: 100,
    estTokensMax: 100,
    sessionsWithErrorCount: 0,
    sessionsWithDeviationCount: 0,
    distinctSessionCount: 1,
    ...over,
  };
}

function shard(
  id: string,
  over: { generatedAt?: string; outcomes?: OutcomeRow[]; buckets?: AggregateBucket[]; rows?: ContextFileRow[] } = {},
): TeamShard {
  const generatedAt = over.generatedAt ?? '2026-10-03T08:00:00.000Z';
  const window = { start: '2026-07-05T00:00:00.000Z', end: '2026-10-03T00:00:00.000Z' };
  return {
    schemaVersion: '1.0',
    generatedAt,
    toolVersion: '1.17.0',
    pseudonymousDeveloperId: id,
    window,
    aggregate: {
      schemaVersion: '1.0',
      batchId: 'b',
      generatedAt,
      toolVersion: '1.17.0',
      pseudonymousDeveloperId: id,
      window,
      buckets: over.buckets ?? [],
    },
    contextInsights: {
      schemaVersion: '1.0',
      batchId: 'c',
      generatedAt,
      toolVersion: '1.17.0',
      pseudonymousDeveloperId: id,
      window,
      rows: over.rows ?? [],
    },
    outcomes: over.outcomes ?? [],
  };
}

function merged(...shards: TeamShard[]): MergedTeam {
  return { members: new Map(shards.map((s) => [s.pseudonymousDeveloperId, s])), problems: [] };
}

describe('windowDays and utcDayString', () => {
  it('lists the window in UTC, oldest first, ending today', () => {
    expect(windowDays('2026-10-03', 7)).toEqual([
      '2026-09-27',
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      '2026-10-02',
      '2026-10-03',
    ]);
    expect(windowDays('2026-03-01', 7)[0]).toBe('2026-02-23');
    expect(utcDayString(Date.UTC(2026, 9, 2, 23, 30))).toBe('2026-10-02');
  });
});

describe('computeTeamMetrics', () => {
  it('counts sessions from outcomes and tokens from buckets, never the other way round', () => {
    const metrics = computeTeamMetrics({
      merged: merged(
        shard(ME, {
          outcomes: [outcome('2026-10-02', { sessionCount: 3, verdictCounts: verdicts({ smooth: 2, bumpy: 1 }), costMicros: 500 })],
          buckets: [bucket('2026-10-02T09:00:00.000Z', 1_000, 200), bucket('2026-10-02T09:30:00.000Z', 500, 100)],
        }),
      ),
      window: 7,
      myId: ME,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(metrics.totals.sessions).toBe(3);
    expect(metrics.totals.inputTokens).toBe(1_500);
    expect(metrics.totals.outputTokens).toBe(300);
    expect(metrics.totals.costMicros).toBe(500);
    expect(metrics.totals.pricedSessions).toBe(3);
    expect(metrics.totals.repositories).toBe(1);
    expect(metrics.daily).toEqual([
      { day: '2026-10-02', members: 1, sessions: 3, inputTokens: 1_500, outputTokens: 300, costMicros: 500 },
    ]);
    expect(metrics.verdictMix).toEqual(verdicts({ smooth: 2, bumpy: 1 }));
    expect(metrics.verdictDaily).toEqual([
      { day: '2026-10-02', verdict: 'smooth', sessions: 2 },
      { day: '2026-10-02', verdict: 'bumpy', sessions: 1 },
    ]);
    expect(metrics.days).toHaveLength(7);
  });

  it('drops rows outside the window, decided by todayUtc rather than any clock', () => {
    const metrics = computeTeamMetrics({
      merged: merged(
        shard(ME, {
          outcomes: [outcome('2026-09-26'), outcome('2026-09-27'), outcome('2026-10-04')],
          buckets: [bucket('2026-09-26T23:59:00.000Z', 10), bucket('2026-09-27T00:00:00.000Z', 20)],
        }),
      ),
      window: 7,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(metrics.totals.sessions).toBe(1);
    expect(metrics.totals.inputTokens).toBe(20);
    expect(metrics.daily.map((d) => d.day)).toEqual(['2026-09-27']);
  });

  it('counts a member as active on a day from either an outcome or a bucket, and builds adoption cumulatively', () => {
    const metrics = computeTeamMetrics({
      merged: merged(
        shard(ME, { outcomes: [outcome('2026-09-28')] }),
        shard(PEER, { buckets: [bucket('2026-09-30T10:00:00.000Z', 5)] }),
        shard(THIRD),
      ),
      window: 7,
      myId: ME,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(metrics.totals.members).toBe(3);
    expect(metrics.totals.activeMembers).toBe(2);
    expect(metrics.daily.map((d) => [d.day, d.members])).toEqual([
      ['2026-09-28', 1],
      ['2026-09-30', 1],
    ]);
    expect(metrics.adoption.map((a) => a.members)).toEqual([0, 1, 1, 2, 2, 2, 2]);
  });

  it('compares the viewer with the median and mean of the OTHER members and ranks by sessions', () => {
    const metrics = computeTeamMetrics({
      merged: merged(
        shard(ME, { outcomes: [outcome('2026-10-01', { sessionCount: 4 })] }),
        shard(PEER, { outcomes: [outcome('2026-10-01', { sessionCount: 10 })] }),
        shard(THIRD, { outcomes: [outcome('2026-10-01', { sessionCount: 1 })] }),
      ),
      window: 7,
      myId: ME,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(metrics.me?.mine.sessions).toBe(4);
    expect(metrics.me?.teamMean.sessions).toBe(6);
    expect(metrics.me?.teamMedian.sessions).toBe(6);
    expect(metrics.me?.comparedMembers).toBe(2);
    expect(metrics.me?.rankBySessions).toBe(2);
    expect(metrics.members.map((m) => m.isMe)).toEqual([true, false, false]);
  });

  it('omits the comparison when the viewer is not in the folder, and the rank when alone', () => {
    const alone = computeTeamMetrics({
      merged: merged(shard(ME, { outcomes: [outcome('2026-10-01')] })),
      window: 7,
      myId: ME,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(alone.me?.rankBySessions).toBeUndefined();
    expect(alone.me?.comparedMembers).toBe(0);
    expect(alone.me?.teamMedian.sessions).toBe(0);

    const absent = computeTeamMetrics({
      merged: merged(shard(PEER, { outcomes: [outcome('2026-10-01')] })),
      window: 7,
      myId: ME,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(absent.me).toBeUndefined();
  });

  it('ranks repositories by sessions with distinct members and the viewer’s share', () => {
    const other = 'https://github.com/o/other';
    const metrics = computeTeamMetrics({
      merged: merged(
        shard(ME, { outcomes: [outcome('2026-10-01', { sessionCount: 2 }), outcome('2026-10-01', { repository: other })] }),
        shard(PEER, { outcomes: [outcome('2026-10-01', { sessionCount: 5 }), outcome('2026-10-02', { repository: 'unknown' })] }),
      ),
      window: 7,
      myId: ME,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(metrics.topRepositories).toEqual([
      { repository: REPO, sessions: 7, members: 2, mine: 2 },
      { repository: other, sessions: 1, members: 1, mine: 1 },
    ]);
    expect(metrics.totals.repositories).toBe(2);
  });

  it('folds context hotspots across members: sums for counts, max for tokens, distinct members, scored', () => {
    const metrics = computeTeamMetrics({
      merged: merged(
        shard(ME, { rows: [contextRow('2026-10-01T10:00:00.000Z', { estTokensMax: 300, skippedCount: 1 })] }),
        shard(PEER, { rows: [contextRow('2026-10-02T10:00:00.000Z', { estTokensMax: 900, appliedCount: 3 })] }),
        shard(THIRD, { rows: [contextRow('2026-09-01T10:00:00.000Z', { estTokensMax: 5_000 })] }),
      ),
      window: 7,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(metrics.hotspots).toHaveLength(1);
    const [row] = metrics.hotspots;
    expect(row).toMatchObject({
      repository: REPO,
      contextFile: 'AGENTS.md',
      appliedCount: 4,
      skippedCount: 1,
      estTokensMax: 900,
      members: 2,
    });
    expect(row.score).toBeGreaterThan(0);
    expect('file' in row).toBe(false);
  });

  it('flags a shard as stale only beyond a week plus a day of tolerance, and counts cost modes', () => {
    const fresh = new Date(NOW - TEAM_STALE_MS - TEAM_STALE_TOLERANCE_MS).toISOString();
    const stale = new Date(NOW - TEAM_STALE_MS - TEAM_STALE_TOLERANCE_MS - 1).toISOString();
    const metrics = computeTeamMetrics({
      merged: merged(
        shard(ME, { generatedAt: fresh, outcomes: [outcome('2026-10-01', { sessionCount: 2, costMode: 'usd' })] }),
        shard(PEER, { generatedAt: stale, outcomes: [outcome('2026-10-01', { source: 'copilot', costMode: 'aiu' })] }),
      ),
      window: 7,
      myId: ME,
      todayUtc: TODAY,
      nowMs: NOW,
    });
    expect(metrics.members.map((m) => m.stale)).toEqual([false, true]);
    expect(metrics.staleMembers).toBe(1);
    expect(metrics.costModes).toEqual({ usd: 2, aiu: 1, credits: 0 });
    expect(metrics.members[0]).toMatchObject({
      developerId: ME,
      isMe: true,
      toolVersion: '1.17.0',
      bucketCount: 0,
      contextRowCount: 0,
      outcomeRowCount: 1,
    });
  });
});
