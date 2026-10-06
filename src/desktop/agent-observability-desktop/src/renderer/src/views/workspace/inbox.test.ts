import { describe, expect, it } from 'vitest';
import type { InboxItem, InboxSnapshot } from '../../../../shared/rpc';
import { flagLabel, flagLabels, groupInbox, inboxNotifications, inboxSummary, reasonLabel, snoozeUntil } from './inbox';

function item(over: Partial<InboxItem> = {}): InboxItem {
  return {
    key: 'claude:s|waiting',
    source: 'claude',
    sessionId: 's',
    reason: 'waiting',
    state: 'new',
    tier: 2,
    flags: [],
    exact: true,
    repository: 'https://github.com/o/repo',
    title: 'Fix the build',
    sinceMs: 0,
    pendingTools: [],
    ...over,
  };
}

function snapshot(items: InboxItem[]): InboxSnapshot {
  return { items, unread: items.filter((i) => i.state === 'new').length, generatedAtMs: 0, lastVisitMs: 0 };
}

describe('reasonLabel', () => {
  it('states a fact only for an exact reason and says "may be" for the guess', () => {
    expect(reasonLabel(item({ reason: 'permission' }))).toBe('Waiting for your approval');
    expect(reasonLabel(item({ reason: 'permission-likely', exact: false, pendingTools: ['Bash'] }))).toBe(
      'May be waiting for approval (Bash call pending)',
    );
    expect(reasonLabel(item({ reason: 'permission-likely', exact: false, pendingTools: ['Read', 'Grep'] }))).toContain(
      'tool call pending',
    );
    expect(reasonLabel(item({ reason: 'waiting' }))).toBe('Waiting for you');
    expect(reasonLabel(item({ reason: 'ended-error' }))).toBe('Ended on a failed tool call');
    expect(reasonLabel(item({ reason: 'ended-interrupted' }))).toBe('Ended while interrupted');
    expect(reasonLabel(item({ reason: 'finished' }))).toBe('Finished');
  });
});

describe('flag labels', () => {
  it('names every flag and collapses the two that read the same', () => {
    expect(flagLabel('contradicted')).toBe('Reported done, last check failed');
    expect(flagLabel('cost-outlier')).toBe('Unusually expensive');
    expect(flagLabels(['incomplete', 'abandoned', 'struggled'])).toEqual(['Left unfinished', 'Struggled']);
  });
});

describe('groupInbox', () => {
  it('splits live reasons from finished ones and keeps the given order', () => {
    const groups = groupInbox([
      item({ key: 'a', reason: 'permission-likely' }),
      item({ key: 'b', reason: 'finished' }),
      item({ key: 'c', reason: 'waiting' }),
      item({ key: 'd', reason: 'ended-error' }),
    ]);
    expect(groups.now.map((i) => i.key)).toEqual(['a', 'c']);
    expect(groups.since.map((i) => i.key)).toEqual(['b', 'd']);
  });
});

describe('snoozeUntil', () => {
  it('adds fixed durations', () => {
    expect(snoozeUntil('15m', 1_000)).toBe(1_000 + 900_000);
    expect(snoozeUntil('1h', 0)).toBe(3_600_000);
    expect(snoozeUntil('4h', 0)).toBe(14_400_000);
  });
});

describe('inboxNotifications', () => {
  it('notifies nothing on the first snapshot of a run', () => {
    const { decisions, keys } = inboxNotifications(undefined, snapshot([item({ key: 'p', reason: 'permission' })]));
    expect(decisions).toEqual([]);
    expect([...keys]).toEqual(['p']);
  });

  it('notifies newly appeared approval prompts and error endings only', () => {
    const { decisions } = inboxNotifications(
      new Set(['known']),
      snapshot([
        item({ key: 'known', reason: 'permission' }),
        item({ key: 'p', reason: 'permission', title: undefined }),
        item({ key: 'g', reason: 'permission-likely', exact: false }),
        item({ key: 'e', reason: 'ended-error' }),
        item({ key: 'w', reason: 'waiting' }),
        item({ key: 'f', reason: 'finished' }),
        item({ key: 's', reason: 'ended-error', state: 'seen' }),
      ]),
    );
    expect(decisions.map((d) => [d.key, d.title])).toEqual([
      ['p', 'Waiting for your approval · o/repo'],
      ['g', 'May be waiting for approval · Fix the build'],
      ['e', 'Ended on an error · Fix the build'],
    ]);
    expect(decisions[0].body).toBe('o/repo');
  });
});

describe('inboxSummary', () => {
  it('says how many are new, or that nothing is', () => {
    expect(inboxSummary(snapshot([]))).toBe('Nothing needs you');
    expect(inboxSummary(snapshot([item({ state: 'seen' })]))).toBe('Nothing new');
    expect(inboxSummary(snapshot([item(), item({ key: 'b' })]))).toBe('2 new');
  });
});
