import { describe, expect, it } from 'vitest';
import { LIVE_FINISHED_MS, LIVE_IDLE_MS, PENDING_TOOL_HINT_MS } from '../live/liveStatus';
import {
  COST_OUTLIER_MIN_SAMPLE,
  INBOX_MAX_ITEMS,
  INBOX_RETENTION_MS,
  PERMISSION_HINT_SLOW_TOOL_MS,
  attentionKey,
  attentionTier,
  compareAttention,
  finishedCandidates,
  isCostOutlier,
  liveCandidates,
  reconcile,
  unreadCount,
  type AttentionCandidate,
  type FinishedFacts,
  type LiveFacts,
  type StoredAttention,
} from './attention';

/** A fixed instant; every time below is numeric milliseconds relative to it. */
const NOW = 1_700_000_000_000;

function live(over: Partial<LiveFacts> = {}): LiveFacts {
  return {
    source: 'claude',
    sessionId: 's',
    lastEvent: 'assistant-text',
    lastActivityMs: NOW - 10_000,
    pendingTools: [],
    status: 'waiting',
    ...over,
  };
}

function finished(over: Partial<FinishedFacts> = {}): FinishedFacts {
  return { source: 'claude', sessionId: 's', endedAtMs: NOW - 60_000, ...over };
}

function candidate(over: Partial<AttentionCandidate> = {}): AttentionCandidate {
  const reason = over.reason ?? 'finished';
  const sessionId = over.sessionId ?? 's';
  return {
    key: attentionKey('claude', sessionId, reason),
    source: 'claude',
    sessionId,
    reason,
    episodeMs: NOW,
    exact: false,
    flags: [],
    pendingTools: [],
    ...over,
  };
}

describe('liveCandidates', () => {
  it('lists a waiting session by its last event, even after its card has gone idle', () => {
    const age = LIVE_IDLE_MS + 60_000;
    const [item] = liveCandidates([live({ status: 'idle', lastActivityMs: NOW - age })], NOW);
    expect(item).toMatchObject({ reason: 'waiting', exact: true, episodeMs: NOW - age, key: 'claude:s|waiting' });
    for (const lastEvent of ['turn-ended', 'interruption'] as const) {
      expect(liveCandidates([live({ lastEvent })], NOW)[0].reason).toBe('waiting');
    }
  });

  it('leaves working sessions and sessions past the finished threshold alone', () => {
    expect(liveCandidates([live({ lastEvent: 'user-prompt', status: 'working' })], NOW)).toEqual([]);
    expect(liveCandidates([live({ lastEvent: 'tool-result', status: 'working' })], NOW)).toEqual([]);
    expect(liveCandidates([live({ lastActivityMs: NOW - LIVE_FINISHED_MS })], NOW)).toEqual([]);
    expect(liveCandidates([live({ lastActivityMs: NOW - 5_000 })], NOW, 4_000)).toEqual([]);
  });

  it('guesses an approval prompt only after the pending-tool delay', () => {
    const pending = (ageMs: number, tools: string[]): LiveFacts =>
      live({ lastEvent: 'tool-pending', status: 'working', pendingTools: tools, lastActivityMs: NOW - ageMs });
    expect(liveCandidates([pending(PENDING_TOOL_HINT_MS - 1, ['Edit'])], NOW)).toEqual([]);
    const [item] = liveCandidates([pending(PENDING_TOOL_HINT_MS, ['Edit'])], NOW);
    expect(item).toMatchObject({ reason: 'permission-likely', exact: false, pendingTools: ['Edit'] });
  });

  it('gives shell-like tools the longer threshold, in any letter case', () => {
    const pending = (ageMs: number, tool: string): LiveFacts =>
      live({ lastEvent: 'tool-pending', status: 'working', pendingTools: [tool], lastActivityMs: NOW - ageMs });
    for (const tool of ['Bash', 'powershell', 'run_in_terminal']) {
      expect(liveCandidates([pending(PERMISSION_HINT_SLOW_TOOL_MS - 1, tool)], NOW)).toEqual([]);
      expect(liveCandidates([pending(PERMISSION_HINT_SLOW_TOOL_MS, tool)], NOW)[0].reason).toBe('permission-likely');
    }
  });

  it('never reads a pending sub-agent call as an approval prompt', () => {
    for (const tools of [['Task'], ['Agent'], ['Edit', 'task']]) {
      const row = live({
        lastEvent: 'tool-pending',
        status: 'working',
        pendingTools: tools,
        lastActivityMs: NOW - 20 * 60_000,
      });
      expect(liveCandidates([row], NOW)).toEqual([]);
    }
  });

  it('reports an exact permission request only when the host says so', () => {
    const row = live({ lastEvent: 'tool-pending', status: 'working', pendingTools: ['Bash'], exactPermission: true });
    expect(liveCandidates([row], NOW)[0]).toMatchObject({ reason: 'permission', exact: true, pendingTools: ['Bash'] });
  });
});

describe('finishedCandidates', () => {
  it('yields one item per session at or after the floor, with its flags', () => {
    const items = finishedCandidates(
      [
        finished({ sessionId: 'old', endedAtMs: NOW - 10_000 }),
        finished({ sessionId: 'a', completion: 'contradicted', verdict: 'struggled' }),
        finished({ sessionId: 'b', completion: 'verified', verdict: 'smooth' }),
        finished({ sessionId: 'c', lastToolFailed: true, terminalEvent: 'tool-result' }),
        finished({ sessionId: 'd', terminalEvent: 'interruption', verdict: 'abandoned' }),
        finished({ sessionId: 'e', terminalEvent: 'tool-pending' }),
      ],
      NOW - 5 * 60_000,
    );
    const byId = new Map(items.map((i) => [i.sessionId, i]));
    expect(byId.get('old')?.reason).toBe('finished');
    expect(byId.get('a')).toMatchObject({ reason: 'finished', flags: ['contradicted', 'struggled'], exact: false });
    expect(byId.get('b')?.flags).toEqual([]);
    expect(byId.get('c')?.reason).toBe('ended-error');
    expect(byId.get('d')).toMatchObject({ reason: 'ended-interrupted', flags: ['abandoned'] });
    expect(byId.get('e')?.reason).toBe('ended-interrupted');
    expect(finishedCandidates([finished({ endedAtMs: NOW - 10 })], NOW)).toEqual([]);
  });

  it('flags a cost outlier only with a large enough sample', () => {
    expect(isCostOutlier(300, 100, COST_OUTLIER_MIN_SAMPLE)).toBe(true);
    expect(isCostOutlier(299, 100, COST_OUTLIER_MIN_SAMPLE)).toBe(false);
    expect(isCostOutlier(300, 100, COST_OUTLIER_MIN_SAMPLE - 1)).toBe(false);
    expect(isCostOutlier(300, 0, 50)).toBe(false);
    expect(isCostOutlier(undefined, 100, 50)).toBe(false);
    expect(isCostOutlier(300, undefined, 50)).toBe(false);
    const [item] = finishedCandidates(
      [finished({ costMicros: 900, repositoryMedianCostMicros: 100, repositorySample: 12 })],
      0,
    );
    expect(item.flags).toEqual(['cost-outlier']);
  });
});

describe('ranking', () => {
  const rows: [string, Partial<AttentionCandidate>, number][] = [
    ['exact permission', { reason: 'permission' }, 0],
    ['probable approval', { reason: 'permission-likely' }, 1],
    ['waiting', { reason: 'waiting' }, 2],
    ['finished, contradicted', { reason: 'finished', flags: ['contradicted'] }, 3],
    ['ended on an error', { reason: 'ended-error' }, 4],
    ['ended on an error, contradicted', { reason: 'ended-error', flags: ['contradicted'] }, 3],
    ['finished, unverified', { reason: 'finished', flags: ['unverified'] }, 5],
    ['finished, incomplete', { reason: 'finished', flags: ['incomplete'] }, 5],
    ['finished, struggled', { reason: 'finished', flags: ['struggled'] }, 6],
    ['finished, abandoned', { reason: 'finished', flags: ['abandoned'] }, 6],
    ['ended interrupted', { reason: 'ended-interrupted' }, 7],
    ['finished, cost outlier', { reason: 'finished', flags: ['cost-outlier'] }, 8],
    ['finished, nothing notable', { reason: 'finished' }, 9],
    ['finished, several flags takes the best', { reason: 'finished', flags: ['cost-outlier', 'unverified'] }, 5],
  ];

  it.each(rows)('%s is tier %#', (_name, over, tier) => {
    expect(attentionTier(candidate(over))).toBe(tier);
  });

  it('orders by tier, then blocked-longest for live and newest for finished, then key', () => {
    const items = [
      candidate({ sessionId: 'f-old', reason: 'finished', episodeMs: NOW - 9_000 }),
      candidate({ sessionId: 'f-new', reason: 'finished', episodeMs: NOW - 1_000 }),
      candidate({ sessionId: 'w-recent', reason: 'waiting', episodeMs: NOW - 1_000 }),
      candidate({ sessionId: 'w-long', reason: 'waiting', episodeMs: NOW - 9_000 }),
      candidate({ sessionId: 'p', reason: 'permission-likely', episodeMs: NOW }),
      candidate({ sessionId: 'tie-b', reason: 'finished', episodeMs: NOW - 5_000 }),
      candidate({ sessionId: 'tie-a', reason: 'finished', episodeMs: NOW - 5_000 }),
      candidate({ sessionId: 'bad', reason: 'finished', flags: ['contradicted'], episodeMs: NOW - 20_000 }),
    ];
    const order = [...items].sort(compareAttention).map((i) => i.sessionId);
    expect(order).toEqual(['p', 'w-long', 'w-recent', 'bad', 'f-new', 'tie-a', 'tie-b', 'f-old']);
    expect([...items].reverse().sort(compareAttention).map((i) => i.sessionId)).toEqual(order);
  });
});

describe('reconcile', () => {
  it('marks an unknown candidate new and counts it unread', () => {
    const { items, next } = reconcile({}, [candidate({ reason: 'waiting', episodeMs: NOW - 5 })], NOW);
    expect(items[0].state).toBe('new');
    expect(next['claude:s|waiting']).toEqual({ state: 'new', episodeMs: NOW - 5, firstSeenMs: NOW });
    expect(unreadCount(items)).toBe(1);
  });

  it('keeps a dismissed item dismissed until a newer episode resets it', () => {
    const stored: Record<string, StoredAttention> = {
      'claude:s|waiting': { state: 'dismissed', episodeMs: NOW - 100, firstSeenMs: NOW - 100 },
    };
    const same = reconcile(stored, [candidate({ reason: 'waiting', episodeMs: NOW - 100 })], NOW);
    expect(same.items[0].state).toBe('dismissed');
    expect(unreadCount(same.items)).toBe(0);
    const again = reconcile(stored, [candidate({ reason: 'waiting', episodeMs: NOW - 10 })], NOW);
    expect(again.items[0].state).toBe('new');
    expect(again.next['claude:s|waiting']).toMatchObject({ episodeMs: NOW - 10, firstSeenMs: NOW });
  });

  it('wakes a snoozed item when its time is up, and not before', () => {
    const stored: Record<string, StoredAttention> = {
      'claude:s|finished': { state: 'snoozed', episodeMs: NOW - 100, firstSeenMs: NOW - 100, snoozedUntilMs: NOW + 50 },
    };
    const c = candidate({ reason: 'finished', episodeMs: NOW - 100 });
    const before = reconcile(stored, [c], NOW);
    expect(before.items[0]).toMatchObject({ state: 'snoozed', snoozedUntilMs: NOW + 50 });
    const after = reconcile(stored, [c], NOW + 50);
    expect(after.items[0].state).toBe('new');
    expect(after.next['claude:s|finished'].snoozedUntilMs).toBeUndefined();
    expect(after.next['claude:s|finished'].firstSeenMs).toBe(NOW - 100);
  });

  it('forgets a live item once its condition clears, but remembers finished ones for the retention period', () => {
    const stored: Record<string, StoredAttention> = {
      'claude:a|waiting': { state: 'seen', episodeMs: NOW - 100, firstSeenMs: NOW - 100 },
      'claude:b|permission-likely': { state: 'new', episodeMs: NOW - 100, firstSeenMs: NOW - 100 },
      'claude:c|finished': { state: 'dismissed', episodeMs: NOW - 100, firstSeenMs: NOW - 100, terminalEvent: 'turn-ended' },
      'claude:d|ended-error': { state: 'seen', episodeMs: NOW - INBOX_RETENTION_MS, firstSeenMs: 0 },
    };
    const { items, next } = reconcile(stored, [], NOW);
    expect(items).toEqual([]);
    expect(Object.keys(next)).toEqual(['claude:c|finished']);
    expect(next['claude:c|finished'].terminalEvent).toBe('turn-ended');
  });

  it('prunes finished records oldest-first down to the cap, keeping current candidates', () => {
    const stored: Record<string, StoredAttention> = {};
    for (let i = 0; i < INBOX_MAX_ITEMS + 5; i += 1) {
      stored[`claude:old-${i}|finished`] = { state: 'dismissed', episodeMs: NOW - 1_000_000 + i, firstSeenMs: 0 };
    }
    const current = candidate({ sessionId: 'current', reason: 'finished', episodeMs: NOW - 2_000_000 });
    const { next, items } = reconcile(stored, [current], NOW);
    expect(Object.keys(next)).toHaveLength(INBOX_MAX_ITEMS);
    expect(next['claude:current|finished']).toBeDefined();
    for (let i = 0; i < 6; i += 1) {
      expect(next[`claude:old-${i}|finished`]).toBeUndefined();
    }
    expect(next['claude:old-6|finished']).toBeDefined();
    expect(items).toHaveLength(1);
  });

  it('returns items already sorted and ignores a duplicate key', () => {
    const { items } = reconcile(
      {},
      [
        candidate({ sessionId: 'f', reason: 'finished' }),
        candidate({ sessionId: 'w', reason: 'waiting' }),
        candidate({ sessionId: 'w', reason: 'waiting', episodeMs: NOW - 1 }),
        candidate({ sessionId: 'p', reason: 'permission' }),
      ],
      NOW,
    );
    expect(items.map((i) => i.sessionId)).toEqual(['p', 'w', 'f']);
    expect(unreadCount(items)).toBe(3);
  });
});
