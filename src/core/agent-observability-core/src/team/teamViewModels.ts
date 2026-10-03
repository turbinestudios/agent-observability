import type { OutcomeCostMode, OutcomeVerdict, VerdictCounts } from './teamShardModels';

/**
 * What the Team view shows, computed from merged shards by `teamMetrics.ts`.
 * The desktop's `shared/rpc.ts` mirrors these shapes field for field; the
 * datahost assigns one to the other, so drift is a compile error.
 */

export type TeamWindow = 7 | 30 | 90;
export const TEAM_WINDOWS: readonly TeamWindow[] = [7, 30, 90];
export const DEFAULT_TEAM_WINDOW: TeamWindow = 30;

/** A shard older than this reads as stale on the members list. */
export const TEAM_STALE_MS = 7 * 86_400_000;
/** Clock skew between machines tolerated before a shard is called stale. */
export const TEAM_STALE_TOLERANCE_MS = 86_400_000;

export interface TeamDayPoint {
  /** `YYYY-MM-DD`, UTC. */
  day: string;
  /** Members with any activity that day. */
  members: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
}

export interface TeamVerdictDayPoint {
  day: string;
  verdict: OutcomeVerdict;
  sessions: number;
}

export interface TeamRepositoryRow {
  repository: string;
  sessions: number;
  members: number;
  /** The viewer's own sessions in that repository (0 when not a member). */
  mine: number;
}

export interface TeamHotspotRow {
  repository: string;
  /** Repo-relative context-file path, exactly as the batches carry it. */
  contextFile: string;
  category: string;
  appliedCount: number;
  skippedCount: number;
  estTokensMax: number;
  errorSessions: number;
  deviationSessions: number;
  members: number;
  /** The shared hotspot score, 0–100. */
  score: number;
}

export interface TeamFigures {
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  costMicros: number;
  verdictMix: VerdictCounts;
}

export interface TeamMeVsTeam {
  mine: TeamFigures;
  /** Over the OTHER members (the viewer excluded). */
  teamMedian: TeamFigures;
  teamMean: TeamFigures;
  /** 1 = most sessions among all members. Absent when alone. */
  rankBySessions?: number;
  comparedMembers: number;
}

export interface TeamMemberInfo {
  developerId: string;
  isMe: boolean;
  generatedAtMs: number;
  toolVersion: string;
  windowStartMs: number;
  windowEndMs: number;
  bucketCount: number;
  contextRowCount: number;
  outcomeRowCount: number;
  stale: boolean;
}

export interface TeamMetrics {
  window: TeamWindow;
  /** Every UTC day in the window, oldest first, including empty ones. */
  days: string[];
  totals: {
    members: number;
    /** Members with any activity inside the window. */
    activeMembers: number;
    sessions: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    pricedSessions: number;
    repositories: number;
  };
  daily: TeamDayPoint[];
  verdictDaily: TeamVerdictDayPoint[];
  verdictMix: VerdictCounts;
  topRepositories: TeamRepositoryRow[];
  hotspots: TeamHotspotRow[];
  /** Cumulative distinct members by first-seen day, over the window's days. */
  adoption: { day: string; members: number }[];
  /** Absent when the viewer's own shard is not in the folder. */
  me?: TeamMeVsTeam;
  /** Sessions per billing basis, so a mixed team is never summed silently. */
  costModes: Record<OutcomeCostMode, number>;
  staleMembers: number;
  members: TeamMemberInfo[];
}
