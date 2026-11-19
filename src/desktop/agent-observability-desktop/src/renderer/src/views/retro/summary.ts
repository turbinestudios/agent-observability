import type { EvidenceSummaryResult, SummaryDayPoint } from '../../../../shared/rpc';
import { EDIT_RECORDING_SOURCES } from '../../../../shared/rpc';
import type { SessionFilters } from '../sessions/filters';
import { shortRepo, sourceLabel } from '../sessions/format';

/**
 * Evidence > Summary, the parts that need no DOM: what the tab is scoped to,
 * how that is remembered, the day buckets the charts draw, and the lines that
 * say how complete a figure is. Split from the component so it tests under the
 * node-only vitest setup, like `tabs.ts`.
 */

/** What the Summary adds up: one repository, one tag, or (empty value) everything. */
export interface SummaryScope {
  kind: 'repository' | 'tag';
  /** Empty means "all repositories" / "all tags", i.e. no narrowing. */
  value: string;
}

export const DEFAULT_SUMMARY_SCOPE: SummaryScope = { kind: 'repository', value: '' };

const STORAGE_KEY = 'agent-observability.summaryScope';

/** Narrow an untrusted value (a stored preference) to a scope, falling back to the default. */
export function toSummaryScope(value: unknown): SummaryScope {
  if (typeof value !== 'object' || value === null) {
    return DEFAULT_SUMMARY_SCOPE;
  }
  const { kind, value: chosen } = value as { kind?: unknown; value?: unknown };
  if ((kind !== 'repository' && kind !== 'tag') || typeof chosen !== 'string') {
    return DEFAULT_SUMMARY_SCOPE;
  }
  return { kind, value: chosen };
}

/** Best-effort, like the tab itself: no storage, no memory. */
export function readStoredScope(): SummaryScope {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === null ? DEFAULT_SUMMARY_SCOPE : toSummaryScope(JSON.parse(raw));
  } catch {
    return DEFAULT_SUMMARY_SCOPE;
  }
}

export function persistScope(scope: SummaryScope): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(scope));
  } catch {
    // Storage unavailable; the choice still applies for this run.
  }
}

/** The RPC parameters for a scope: nothing for "all", else the one narrowing. */
export function scopeParams(scope: SummaryScope): { repository?: string; tag?: string } {
  if (scope.value === '') {
    return {};
  }
  return scope.kind === 'repository' ? { repository: scope.value } : { tag: scope.value };
}

/**
 * The Sessions filter a drill-down starts from, so the list answers the same
 * question the Summary did. A tag scope carries the tag, a repository scope
 * the repository.
 */
export function scopeFilters(scope: SummaryScope): SessionFilters {
  return scopeParams(scope);
}

/** One chart column: a local day and what happened on it. */
export interface SummaryDay {
  /** `YYYY-MM-DD`, local: the identity a click on this column drills into. */
  iso: string;
  date: Date;
  sessionsBySource: Record<string, number>;
  costBySource: Record<string, number>;
  linesAdded: number;
  linesRemoved: number;
}

/**
 * Expand the sparse daily rows into one bucket per day, oldest first, ending
 * today. Days with no sessions are kept as empty columns: dropping them would
 * make a quiet week look continuous.
 */
export function buildSummaryDays(
  daily: readonly SummaryDayPoint[],
  windowDays: number,
  now: Date = new Date(),
): SummaryDay[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const byDay = new Map<string, SummaryDay>();
  for (let i = Math.max(1, windowDays) - 1; i >= 0; i -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
    const iso = isoDay(date);
    byDay.set(iso, { iso, date, sessionsBySource: {}, costBySource: {}, linesAdded: 0, linesRemoved: 0 });
  }
  for (const point of daily) {
    const bucket = byDay.get(point.day);
    if (bucket === undefined) {
      continue; // outside the window (clock skew, or a future-dated row)
    }
    bucket.sessionsBySource[point.source] = (bucket.sessionsBySource[point.source] ?? 0) + point.sessions;
    bucket.costBySource[point.source] = (bucket.costBySource[point.source] ?? 0) + point.costMicros;
    bucket.linesAdded += point.linesAdded;
    bucket.linesRemoved += point.linesRemoved;
  }
  return [...byDay.values()];
}

/** `YYYY-MM-DD` in local time, matching the SQL grouping. */
export function isoDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** "Claude Code and OpenCode": the agents whose sessions record their edits. */
export function editRecordingAgents(): string {
  const names = EDIT_RECORDING_SOURCES.map(sourceLabel);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Whether any session in scope could carry code figures at all. */
export function codeRecorded(code: EvidenceSummaryResult['code']): boolean {
  return code.coveredSessions > 0;
}

/**
 * What the code figures cover, or `undefined` when they cover every session
 * in scope. Two things can make them partial: sessions from agents that do
 * not record edits, and sessions the background analysis has not read yet.
 * Either way the total has to say so rather than read as final, or as zero.
 */
export function codeCoverageLine(summary: Pick<EvidenceSummaryResult, 'code' | 'totals'>): string | undefined {
  const { coveredSessions, analyzedSessions } = summary.code;
  const { sessions } = summary.totals;
  if (sessions === 0) {
    return undefined;
  }
  if (coveredSessions === 0) {
    return `Lines and files are recorded for ${editRecordingAgents()} sessions only, and none are in this scope`;
  }
  const notes: string[] = [];
  if (coveredSessions < sessions) {
    notes.push(
      `counts ${editRecordingAgents()} sessions only (${coveredSessions.toLocaleString()} of ${sessions.toLocaleString()})`,
    );
  }
  if (analyzedSessions < coveredSessions) {
    notes.push(`${analyzedSessions.toLocaleString()} of ${coveredSessions.toLocaleString()} analyzed so far`);
  }
  return notes.length === 0 ? undefined : notes.join('; ');
}

/** The cost tile's footnote: which sessions the estimate covers. */
export function costCoverageLine(totals: EvidenceSummaryResult['totals']): string {
  return (
    `Estimated from token rates and billed premium-request usage. Covers ` +
    `${totals.costSessions.toLocaleString()} of ${totals.sessions.toLocaleString()} sessions; ` +
    `the rest could not be priced.`
  );
}

/** What the header says the figures cover, as a sentence. */
export function scopeDescription(scope: SummaryScope): string {
  if (scope.value === '') {
    return 'Every session in every repository';
  }
  return scope.kind === 'repository' ? `Sessions in ${shortRepo(scope.value)}` : `Sessions tagged #${scope.value}`;
}
