import type { InboxFlag, InboxItem, InboxSnapshot } from '../../../../shared/rpc';
import { shortRepo } from '../sessions/format';

/**
 * Presentation rules for the attention inbox, split from the components so
 * they test under the node-only vitest setup.
 *
 * Wording rule: only an `exact` item states a fact. A probable approval prompt
 * is inferred from a tool call that has been quiet for a while, so it always
 * reads "may be".
 */

export type SnoozeOption = '15m' | '1h' | '4h';

export const SNOOZE_OPTIONS: readonly { option: SnoozeOption; label: string }[] = [
  { option: '15m', label: '15 min' },
  { option: '1h', label: '1 h' },
  { option: '4h', label: '4 h' },
];

const SNOOZE_MS: Readonly<Record<SnoozeOption, number>> = {
  '15m': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
};

/** Fixed durations on purpose: nothing here depends on the machine's time zone. */
export function snoozeUntil(option: SnoozeOption, nowMs: number): number {
  return nowMs + SNOOZE_MS[option];
}

export function reasonLabel(item: Pick<InboxItem, 'reason' | 'exact' | 'pendingTools'>): string {
  switch (item.reason) {
    case 'permission':
      return 'Waiting for your approval';
    case 'permission-likely': {
      const tool = item.pendingTools.length === 1 ? `${item.pendingTools[0]} call` : 'tool call';
      return `May be waiting for approval (${tool} pending)`;
    }
    case 'waiting':
      return 'Waiting for you';
    case 'ended-error':
      return 'Ended on a failed tool call';
    case 'ended-interrupted':
      return 'Ended while interrupted';
    case 'finished':
      return 'Finished';
  }
}

export function flagLabel(flag: InboxFlag): string {
  switch (flag) {
    case 'contradicted':
      return 'Reported done, last check failed';
    case 'unverified':
      return 'Not verified';
    case 'incomplete':
      return 'Left unfinished';
    case 'struggled':
      return 'Struggled';
    case 'abandoned':
      return 'Left unfinished';
    case 'cost-outlier':
      return 'Unusually expensive';
  }
}

/** Distinct labels, in order: `incomplete` and `abandoned` read the same to a user. */
export function flagLabels(flags: readonly InboxFlag[]): string[] {
  return [...new Set(flags.map(flagLabel))];
}

const LIVE_REASONS: ReadonlySet<string> = new Set(['permission', 'permission-likely', 'waiting']);

/** The datahost's order is kept inside each group; only the split is decided here. */
export function groupInbox(items: readonly InboxItem[]): { now: InboxItem[]; since: InboxItem[] } {
  return {
    now: items.filter((item) => LIVE_REASONS.has(item.reason)),
    since: items.filter((item) => !LIVE_REASONS.has(item.reason)),
  };
}

export interface InboxNotifyDecision {
  key: string;
  source: string;
  sessionId: string;
  title: string;
  body: string;
}

const NOTIFY_REASONS: ReadonlySet<string> = new Set(['permission', 'permission-likely', 'ended-error']);

/**
 * Which newly appeared items earn a desktop notification. Only approval
 * prompts and error endings: the live notifier already covers "waiting for
 * you" and "finished", so nothing fires twice. The first snapshot of a run
 * notifies nothing.
 */
export function inboxNotifications(
  previousKeys: ReadonlySet<string> | undefined,
  next: InboxSnapshot,
): { decisions: InboxNotifyDecision[]; keys: Set<string> } {
  const keys = new Set(next.items.map((item) => item.key));
  const decisions: InboxNotifyDecision[] = [];
  if (previousKeys !== undefined) {
    for (const item of next.items) {
      if (previousKeys.has(item.key) || item.state !== 'new' || !NOTIFY_REASONS.has(item.reason)) {
        continue;
      }
      const subject = item.title ?? shortRepo(item.repository);
      decisions.push({
        key: item.key,
        source: item.source,
        sessionId: item.sessionId,
        title: `${notifyPrefix(item)} · ${subject}`,
        body: shortRepo(item.repository),
      });
    }
  }
  return { decisions, keys };
}

function notifyPrefix(item: InboxItem): string {
  if (item.reason === 'permission') {
    return 'Waiting for your approval';
  }
  return item.reason === 'permission-likely' ? 'May be waiting for approval' : 'Ended on an error';
}

/** "3 new" / "Nothing new" for the section header. */
export function inboxSummary(snapshot: Pick<InboxSnapshot, 'items' | 'unread'>): string {
  if (snapshot.items.length === 0) {
    return 'Nothing needs you';
  }
  return snapshot.unread === 0 ? 'Nothing new' : `${snapshot.unread} new`;
}
