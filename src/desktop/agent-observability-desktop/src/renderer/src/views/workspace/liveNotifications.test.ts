import { describe, expect, it } from 'vitest';
import type { LiveBoardSnapshot, LiveSessionRow, LiveStatus } from '../../../../shared/rpc';
import { notificationsFor } from './liveNotifications';

function row(overrides: Partial<LiveSessionRow> = {}): LiveSessionRow {
  return {
    source: 'claude',
    sessionId: 'abc',
    repository: 'https://github.com/o/repo',
    title: 'Fix the build',
    status: 'working',
    lastEvent: 'user-prompt',
    startedAtMs: 0,
    lastActivityMs: 0,
    pendingTools: [],
    inputTokens: 0,
    outputTokens: 0,
    countsIndexedAtMs: 0,
    ...overrides,
  };
}

function snapshot(rows: LiveSessionRow[]): LiveBoardSnapshot {
  return { rows, generatedAtMs: 0, watching: true, watchedDirs: 1, idleMs: 1, finishedMs: 2 };
}

describe('notificationsFor', () => {
  it('never notifies on the first snapshot of a run', () => {
    const { decisions, statuses } = notificationsFor(undefined, snapshot([row({ status: 'waiting' })]));
    expect(decisions).toEqual([]);
    expect(statuses.get('claude:abc')).toBe('waiting');
  });

  it('notifies when a working session starts waiting for the user, naming the session and branch', () => {
    const previous = new Map<string, LiveStatus>([['claude:abc', 'working']]);
    const { decisions } = notificationsFor(previous, snapshot([row({ status: 'waiting', branch: 'feat/x' })]));
    expect(decisions).toHaveLength(1);
    expect(decisions[0].title).toBe('Waiting for you · Fix the build');
    expect(decisions[0].body).toBe('o/repo · feat/x');
    expect(decisions[0].key).toBe('claude:abc');
  });

  it('notifies when a session finishes from any live status', () => {
    const previous = new Map<string, LiveStatus>([['claude:abc', 'idle']]);
    const { decisions } = notificationsFor(previous, snapshot([row({ status: 'finished', title: undefined })]));
    expect(decisions.map((d) => d.title)).toEqual(['Finished · o/repo']);
  });

  it('stays quiet for working→idle, waiting→working, unchanged status, and sessions it has not seen', () => {
    const previous = new Map<string, LiveStatus>([
      ['claude:a', 'working'],
      ['claude:b', 'waiting'],
      ['claude:c', 'waiting'],
    ]);
    const { decisions } = notificationsFor(
      previous,
      snapshot([
        row({ sessionId: 'a', status: 'idle' }),
        row({ sessionId: 'b', status: 'working' }),
        row({ sessionId: 'c', status: 'waiting' }),
        row({ sessionId: 'new', status: 'waiting' }),
      ]),
    );
    expect(decisions).toEqual([]);
  });
});
