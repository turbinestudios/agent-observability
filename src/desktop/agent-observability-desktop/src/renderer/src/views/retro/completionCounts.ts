import type { CompletionStatus, CompletionSummary } from '../../../../shared/rpc';
import { COMPLETION_STATUSES } from '../../../../shared/rpc';
import { completionLabel } from '../sessions/completion';
import type { SessionFilters } from '../sessions/filters';

/**
 * Presentation rules for the Completion tab and the Dashboard card. Every
 * figure is shown against its denominator — sessions that changed code and
 * were checked — because a rate without one invites the wrong conclusion.
 */

export interface CompletionRow {
  status: CompletionStatus;
  label: string;
  sessions: number;
  /** Whole percent of `changedCode`; 0 when nothing changed code. */
  pct: number;
}

export function percentOf(part: number, whole: number): number {
  return whole <= 0 ? 0 : Math.round((part / whole) * 100);
}

export function completionRows(summary: CompletionSummary): CompletionRow[] {
  return COMPLETION_STATUSES.map((status) => ({
    status,
    label: completionLabel(status),
    sessions: summary[status],
    pct: percentOf(summary[status], summary.changedCode),
  }));
}

/** The Dashboard card's headline: count and share, with the denominator spelled out. */
export function reportedDoneLine(summary: CompletionSummary): string {
  if (summary.changedCode === 0) {
    return 'No session in this window changed code yet.';
  }
  const sessions = summary.changedCode === 1 ? '1 session' : `${summary.changedCode} sessions`;
  return `${summary.reportedDoneUnverified} of ${sessions} that changed code (${percentOf(
    summary.reportedDoneUnverified,
    summary.changedCode,
  )}%)`;
}

/** The drill-down behind "Reported done, not verified": both statuses, one query. */
export function reportedDoneFilter(base: SessionFilters): SessionFilters {
  return { ...base, completionIn: ['unverified', 'contradicted'], claimedDone: true };
}

export function statusFilter(base: SessionFilters, status: CompletionStatus): SessionFilters {
  return { ...base, completion: status };
}
