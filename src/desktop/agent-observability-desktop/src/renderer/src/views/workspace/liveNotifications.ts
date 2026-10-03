import type { LiveBoardSnapshot, LiveStatus } from '../../../../shared/rpc';
import { sessionKey } from '../../../../shared/rpc';
import { shortRepo } from '../sessions/format';

/**
 * Which desktop notifications a new live snapshot earns, given the statuses
 * the previous one had. Pure, so the rule is testable without a window.
 *
 * Only two transitions notify: a session that was working and now waits for
 * the user, and a session that finished. Nothing fires for the first snapshot
 * of a run (everything on it is old news), for working→idle (the user walked
 * away; telling them so helps nobody), or for a status that did not change.
 */
export interface NotifyDecision {
  key: string;
  source: string;
  sessionId: string;
  title: string;
  body: string;
}

export function notificationsFor(
  previous: ReadonlyMap<string, LiveStatus> | undefined,
  next: LiveBoardSnapshot,
): { decisions: NotifyDecision[]; statuses: Map<string, LiveStatus> } {
  const statuses = new Map<string, LiveStatus>();
  const decisions: NotifyDecision[] = [];
  for (const row of next.rows) {
    const key = sessionKey(row.source, row.sessionId);
    statuses.set(key, row.status);
    if (previous === undefined) {
      continue;
    }
    const before = previous.get(key);
    if (before === undefined || before === row.status) {
      continue;
    }
    const subject = row.title ?? shortRepo(row.repository);
    const body = [shortRepo(row.repository), row.branch].filter((s) => s !== undefined && s.length > 0).join(' · ');
    if (before === 'working' && row.status === 'waiting') {
      decisions.push({ key, source: row.source, sessionId: row.sessionId, title: `Waiting for you · ${subject}`, body });
    } else if (before !== 'finished' && row.status === 'finished') {
      decisions.push({ key, source: row.source, sessionId: row.sessionId, title: `Finished · ${subject}`, body });
    }
  }
  return { decisions, statuses };
}
