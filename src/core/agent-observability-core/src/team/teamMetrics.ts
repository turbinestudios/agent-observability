import { scoreHotspots } from '../analysis/hotspotScore';
import { generatedAtMs, type MergedTeam } from './teamMerge';
import {
  OUTCOME_VERDICTS,
  emptyVerdictCounts,
  type OutcomeCostMode,
  type TeamShard,
  type VerdictCounts,
} from './teamShardModels';
import {
  TEAM_STALE_MS,
  TEAM_STALE_TOLERANCE_MS,
  type TeamDayPoint,
  type TeamFigures,
  type TeamHotspotRow,
  type TeamMeVsTeam,
  type TeamMemberInfo,
  type TeamMetrics,
  type TeamRepositoryRow,
  type TeamVerdictDayPoint,
  type TeamWindow,
} from './teamViewModels';

/**
 * Everything the Team view draws, computed from the merged shards.
 *
 * Two rules keep the numbers honest. Sessions, verdicts and cost come ONLY from
 * the `outcomes` block: a bucket's `distinctSessionCount` is per 30-minute bin
 * and a session spanning three bins would count three times. Tokens come ONLY
 * from the aggregate buckets, keyed by the UTC day of `bucketStart`. Days are
 * UTC throughout, bucketed by each producer; this function never re-bins, so a
 * team spread over time zones agrees on every column.
 *
 * Pure: `todayUtc` and `nowMs` are inputs, so tests are deterministic and the
 * importer's clock only ever decides the window edge and the stale chip.
 */
export interface TeamMetricsInput {
  merged: MergedTeam;
  window: TeamWindow;
  /** The viewer's own id, when their shard may be in the folder. */
  myId?: string;
  /** `YYYY-MM-DD`, the importer's current UTC date. */
  todayUtc: string;
  nowMs: number;
}

const TOP_REPOSITORIES = 10;
const TOP_HOTSPOTS = 10;
const DAY_MS = 86_400_000;

export function utcDayString(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/** `window` UTC days ending at `todayUtc` inclusive, oldest first. */
export function windowDays(todayUtc: string, window: TeamWindow): string[] {
  const end = Date.parse(`${todayUtc}T00:00:00Z`);
  const days: string[] = [];
  for (let i = window - 1; i >= 0; i -= 1) {
    days.push(utcDayString(end - i * DAY_MS));
  }
  return days;
}

export function computeTeamMetrics(input: TeamMetricsInput): TeamMetrics {
  const days = windowDays(input.todayUtc, input.window);
  const inWindow = new Set(days);
  const shards = [...input.merged.members.values()];

  // Per day accumulators.
  const daily = new Map<string, TeamDayPoint & { memberIds: Set<string> }>();
  const dayPoint = (day: string): TeamDayPoint & { memberIds: Set<string> } => {
    let point = daily.get(day);
    if (point === undefined) {
      point = { day, members: 0, sessions: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, memberIds: new Set() };
      daily.set(day, point);
    }
    return point;
  };
  const verdictDaily = new Map<string, TeamVerdictDayPoint>();
  const verdictMix = emptyVerdictCounts();
  const repositories = new Map<string, { sessions: number; members: Set<string>; mine: number }>();
  const activeMembers = new Set<string>();
  const firstSeen = new Map<string, string>();
  const costModes: Record<OutcomeCostMode, number> = { usd: 0, aiu: 0, credits: 0 };
  const perMember = new Map<string, TeamFigures>();
  let pricedSessions = 0;

  const figures = (id: string): TeamFigures => {
    let f = perMember.get(id);
    if (f === undefined) {
      f = { sessions: 0, inputTokens: 0, outputTokens: 0, costMicros: 0, verdictMix: emptyVerdictCounts() };
      perMember.set(id, f);
    }
    return f;
  };
  const noteDay = (id: string, day: string): void => {
    activeMembers.add(id);
    dayPoint(day).memberIds.add(id);
    const seen = firstSeen.get(id);
    if (seen === undefined || day < seen) {
      firstSeen.set(id, day);
    }
  };

  for (const shard of shards) {
    const id = shard.pseudonymousDeveloperId;
    const mine = figures(id);
    for (const row of shard.outcomes) {
      if (!inWindow.has(row.day)) {
        continue;
      }
      noteDay(id, row.day);
      const point = dayPoint(row.day);
      point.sessions += row.sessionCount;
      point.costMicros += row.costMicros;
      mine.sessions += row.sessionCount;
      mine.costMicros += row.costMicros;
      pricedSessions += row.pricedSessionCount;
      costModes[row.costMode] += row.sessionCount;
      for (const verdict of OUTCOME_VERDICTS) {
        const n = row.verdictCounts[verdict];
        if (n === 0) {
          continue;
        }
        verdictMix[verdict] += n;
        mine.verdictMix[verdict] += n;
        const key = `${row.day}|${verdict}`;
        const existing = verdictDaily.get(key);
        if (existing === undefined) {
          verdictDaily.set(key, { day: row.day, verdict, sessions: n });
        } else {
          existing.sessions += n;
        }
      }
      if (row.repository !== 'unknown') {
        let repo = repositories.get(row.repository);
        if (repo === undefined) {
          repo = { sessions: 0, members: new Set(), mine: 0 };
          repositories.set(row.repository, repo);
        }
        repo.sessions += row.sessionCount;
        repo.members.add(id);
        if (id === input.myId) {
          repo.mine += row.sessionCount;
        }
      }
    }
    for (const bucket of shard.aggregate.buckets) {
      const start = Date.parse(bucket.bucketStart);
      if (!Number.isFinite(start)) {
        continue;
      }
      const day = utcDayString(start);
      if (!inWindow.has(day)) {
        continue;
      }
      noteDay(id, day);
      const point = dayPoint(day);
      point.inputTokens += bucket.inputTokens;
      point.outputTokens += bucket.outputTokens;
      mine.inputTokens += bucket.inputTokens;
      mine.outputTokens += bucket.outputTokens;
    }
  }

  const dailyPoints: TeamDayPoint[] = days
    .filter((day) => daily.has(day))
    .map((day) => {
      const { memberIds, ...point } = dayPoint(day);
      return { ...point, members: memberIds.size };
    });

  const totals = {
    members: shards.length,
    activeMembers: activeMembers.size,
    sessions: dailyPoints.reduce((sum, p) => sum + p.sessions, 0),
    inputTokens: dailyPoints.reduce((sum, p) => sum + p.inputTokens, 0),
    outputTokens: dailyPoints.reduce((sum, p) => sum + p.outputTokens, 0),
    costMicros: dailyPoints.reduce((sum, p) => sum + p.costMicros, 0),
    pricedSessions,
    repositories: repositories.size,
  };

  // Adoption: cumulative distinct members by first-seen day.
  let adopted = 0;
  const adoption = days.map((day) => {
    for (const seen of firstSeen.values()) {
      if (seen === day) {
        adopted += 1;
      }
    }
    return { day, members: adopted };
  });

  const topRepositories: TeamRepositoryRow[] = [...repositories.entries()]
    .map(([repository, r]) => ({ repository, sessions: r.sessions, members: r.members.size, mine: r.mine }))
    .sort((a, b) => b.sessions - a.sessions || a.repository.localeCompare(b.repository))
    .slice(0, TOP_REPOSITORIES);

  const members: TeamMemberInfo[] = shards
    .map((shard) => memberInfo(shard, input))
    .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.developerId.localeCompare(b.developerId));

  return {
    window: input.window,
    days,
    totals,
    daily: dailyPoints,
    verdictDaily: [...verdictDaily.values()].sort(
      (a, b) => a.day.localeCompare(b.day) || OUTCOME_VERDICTS.indexOf(a.verdict) - OUTCOME_VERDICTS.indexOf(b.verdict),
    ),
    verdictMix,
    topRepositories,
    hotspots: teamHotspots(shards, inWindow),
    adoption,
    ...meVsTeam(perMember, input.myId),
    costModes,
    staleMembers: members.filter((m) => m.stale).length,
    members,
  };
}

function memberInfo(shard: TeamShard, input: TeamMetricsInput): TeamMemberInfo {
  const generated = generatedAtMs(shard);
  return {
    developerId: shard.pseudonymousDeveloperId,
    isMe: shard.pseudonymousDeveloperId === input.myId,
    generatedAtMs: generated,
    toolVersion: shard.toolVersion,
    windowStartMs: Date.parse(shard.window.start),
    windowEndMs: Date.parse(shard.window.end),
    bucketCount: shard.aggregate.buckets.length,
    contextRowCount: shard.contextInsights.rows.length,
    outcomeRowCount: shard.outcomes.length,
    stale: input.nowMs - generated > TEAM_STALE_MS + TEAM_STALE_TOLERANCE_MS,
  };
}

/** Context-insight rows folded per (repository, file, category) across members, then scored. */
function teamHotspots(shards: readonly TeamShard[], inWindow: ReadonlySet<string>): TeamHotspotRow[] {
  const folded = new Map<string, Omit<TeamHotspotRow, 'members' | 'score'> & { memberIds: Set<string> }>();
  for (const shard of shards) {
    for (const row of shard.contextInsights.rows) {
      const start = Date.parse(row.bucketStart);
      if (!Number.isFinite(start) || !inWindow.has(utcDayString(start))) {
        continue;
      }
      const key = `${row.repository}|${row.contextFile}|${row.category}`;
      let entry = folded.get(key);
      if (entry === undefined) {
        entry = {
          repository: row.repository,
          contextFile: row.contextFile,
          category: row.category,
          appliedCount: 0,
          skippedCount: 0,
          estTokensMax: 0,
          errorSessions: 0,
          deviationSessions: 0,
          memberIds: new Set(),
        };
        folded.set(key, entry);
      }
      entry.appliedCount += row.appliedCount;
      entry.skippedCount += row.skippedCount;
      entry.estTokensMax = Math.max(entry.estTokensMax, row.estTokensMax);
      entry.errorSessions += row.sessionsWithErrorCount;
      entry.deviationSessions += row.sessionsWithDeviationCount;
      entry.memberIds.add(shard.pseudonymousDeveloperId);
    }
  }
  const scorable = [...folded.values()].map(({ memberIds, ...entry }) => ({
    ...entry,
    members: memberIds.size,
    file: `${entry.repository}/${entry.contextFile}`,
  }));
  return scoreHotspots(scorable)
    .slice(0, TOP_HOTSPOTS)
    .map(({ file: _file, ...row }) => row);
}

function meVsTeam(perMember: Map<string, TeamFigures>, myId: string | undefined): { me?: TeamMeVsTeam } {
  if (myId === undefined || !perMember.has(myId)) {
    return {};
  }
  const mine = perMember.get(myId) as TeamFigures;
  const others = [...perMember.entries()].filter(([id]) => id !== myId).map(([, f]) => f);
  const all = [...perMember.values()];
  const rank = all.filter((f) => f.sessions > mine.sessions).length + 1;
  return {
    me: {
      mine,
      teamMedian: aggregateFigures(others, median),
      teamMean: aggregateFigures(others, mean),
      ...(all.length > 1 ? { rankBySessions: rank } : {}),
      comparedMembers: others.length,
    },
  };
}

function aggregateFigures(figures: readonly TeamFigures[], fold: (values: number[]) => number): TeamFigures {
  const pick = (f: (x: TeamFigures) => number): number => (figures.length === 0 ? 0 : fold(figures.map(f)));
  const verdictMix = emptyVerdictCounts();
  for (const verdict of OUTCOME_VERDICTS) {
    verdictMix[verdict] = pick((f) => f.verdictMix[verdict]);
  }
  return {
    sessions: pick((f) => f.sessions),
    inputTokens: pick((f) => f.inputTokens),
    outputTokens: pick((f) => f.outputTokens),
    costMicros: pick((f) => f.costMicros),
    verdictMix: verdictMix as VerdictCounts,
  };
}

function mean(values: number[]): number {
  return Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
