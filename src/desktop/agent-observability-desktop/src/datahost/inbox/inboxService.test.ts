import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LIVE_FINISHED_MS, LIVE_IDLE_MS } from '@agent-observability/core/src/live/liveStatus';
import type { ListSessionsParams, LiveBoardSnapshot, LiveSessionRow, RpcEvent, SessionRow } from '../../shared/rpc';
import { INBOX_RECHECK_MS, InboxService } from './inboxService';
import { InboxStore } from './inboxStore';

/**
 * The inbox over fakes: a fake live board, a fake index and injected timers.
 * All times are numeric milliseconds from a fixed `now`; nothing is formatted.
 */

const START = 1_700_000_000_000;

let dir: string;
let now: number;
let board: LiveSessionRow[];
let indexed: SessionRow[];
let hidden: Set<string>;
let events: RpcEvent[];
let timers: { fn: () => void; ms: number; cancelled: boolean }[];
let store: InboxStore;

function liveRow(over: Partial<LiveSessionRow> & Pick<LiveSessionRow, 'sessionId'>): LiveSessionRow {
  return {
    source: 'claude',
    repository: 'https://github.com/o/repo',
    status: 'working',
    lastEvent: 'user-prompt',
    startedAtMs: now - 60_000,
    lastActivityMs: now,
    pendingTools: [],
    inputTokens: 0,
    outputTokens: 0,
    countsIndexedAtMs: 0,
    ...over,
  };
}

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: 'https://github.com/o/repo',
    title: `Session ${over.sessionId}`,
    startedAtMs: now - 120_000,
    endedAtMs: now - 60_000,
    durationMs: 60_000,
    interactionCount: 1,
    llmCalls: 1,
    toolCalls: 0,
    inputTokens: 10,
    outputTokens: 10,
    cachedTokens: 0,
    model: 'm',
    agentModes: [],
    indexedAtMs: 1,
    ...over,
  };
}

function snapshot(): LiveBoardSnapshot {
  return {
    rows: board,
    generatedAtMs: now,
    watching: true,
    watchedDirs: 1,
    idleMs: LIVE_IDLE_MS,
    finishedMs: LIVE_FINISHED_MS,
  };
}

function service(): InboxService {
  return new InboxService({
    db: {
      listSessions: (params: ListSessionsParams, hiddenKeys: readonly string[] = []) =>
        indexed.filter(
          (r) => r.endedAtMs >= (params.endedAfterMs ?? 0) && !hiddenKeys.includes(`${r.source}:${r.sessionId}`),
        ),
      getRow: (source: string, sessionId: string) =>
        indexed.find((r) => r.source === source && r.sessionId === sessionId),
    },
    hidden: { all: () => [...hidden], isHidden: (s, id) => hidden.has(`${s}:${id}`) },
    renames: { apply: (rows) => rows },
    store,
    live: snapshot,
    emit: (event) => events.push(event),
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => {
        const entry = { fn, ms, cancelled: false };
        timers.push(entry);
        return entry;
      },
      clearTimeout: (handle) => {
        (handle as { cancelled: boolean }).cancelled = true;
      },
    },
  });
}

function inboxEvents(): number {
  return events.filter((e) => e.event === 'inbox.changed').length;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-inbox-svc-'));
  now = START;
  board = [];
  indexed = [];
  hidden = new Set();
  events = [];
  timers = [];
  store = new InboxStore(path.join(dir, 'inbox.json'), () => now);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('InboxService', () => {
  it('lists a session waiting for the user, and keeps it after its card goes idle', () => {
    const inbox = service();
    board = [liveRow({ sessionId: 'w', status: 'waiting', lastEvent: 'assistant-text' })];
    inbox.onLive(snapshot());
    expect(inbox.snapshot().items.map((i) => [i.sessionId, i.reason, i.state])).toEqual([['w', 'waiting', 'new']]);

    now += LIVE_IDLE_MS + 60_000;
    board = [liveRow({ sessionId: 'w', status: 'idle', lastEvent: 'assistant-text', lastActivityMs: START })];
    inbox.onLive(snapshot());
    expect(inbox.snapshot().items.map((i) => i.reason)).toEqual(['waiting']);
    expect(inbox.snapshot().unread).toBe(1);
  });

  it('emits only when the visible list actually changed', () => {
    const inbox = service();
    board = [liveRow({ sessionId: 'w', status: 'waiting', lastEvent: 'turn-ended' })];
    inbox.onLive(snapshot());
    const after = inboxEvents();
    inbox.onLive(snapshot());
    inbox.onIndexSettled();
    expect(inboxEvents()).toBe(after);
  });

  it('never surfaces history from before the first run, and never a hidden session', () => {
    indexed = [row({ sessionId: 'old', endedAtMs: START - 86_400_000 }), row({ sessionId: 'secret', endedAtMs: START + 1 })];
    hidden.add('claude:secret');
    const inbox = service();
    inbox.onIndexSettled();
    expect(inbox.snapshot().items).toEqual([]);
  });

  it('does not list a session as finished while it is still live on the board', () => {
    now += 10_000;
    indexed = [row({ sessionId: 's', endedAtMs: now - 1_000 })];
    board = [liveRow({ sessionId: 's', status: 'working' })];
    const inbox = service();
    inbox.onLive(snapshot());
    expect(inbox.snapshot().items).toEqual([]);

    board = [];
    inbox.onLive(snapshot());
    expect(inbox.snapshot().items.map((i) => [i.sessionId, i.reason, i.title])).toEqual([['s', 'finished', 'Session s']]);
  });

  it('remembers how a session ended after the board stops reading its tail', () => {
    now += 10_000;
    const inbox = service();
    board = [liveRow({ sessionId: 'e', status: 'working', lastEvent: 'tool-result', lastToolFailed: true })];
    inbox.onLive(snapshot());

    // Half an hour later the board only knows the session is finished.
    const endedAt = now;
    now += LIVE_FINISHED_MS + 1;
    board = [liveRow({ sessionId: 'e', status: 'finished', lastEvent: 'unknown', lastActivityMs: endedAt })];
    indexed = [row({ sessionId: 'e', endedAtMs: endedAt, verdict: 'struggled' })];
    inbox.onLive(snapshot());
    const [item] = inbox.snapshot().items;
    expect(item.reason).toBe('ended-error');
    expect(item.flags).toContain('struggled');
    expect(item.verdict).toBe('struggled');

    // And it survives a restart: the ending is in the store, not in memory.
    const reopened = new InboxService({
      db: { listSessions: () => indexed, getRow: () => indexed[0] },
      hidden: { all: () => [], isHidden: () => false },
      renames: { apply: (rows) => rows },
      store: new InboxStore(path.join(dir, 'inbox.json'), () => now),
      live: () => ({ ...snapshot(), rows: [] }),
      emit: () => undefined,
      now: () => now,
    });
    expect(reopened.snapshot().items.map((i) => i.reason)).toEqual(['ended-error']);
  });

  it('keeps a dismissed item away until the session needs the user again', () => {
    const inbox = service();
    board = [liveRow({ sessionId: 'w', status: 'waiting', lastEvent: 'assistant-text', lastActivityMs: now })];
    inbox.onLive(snapshot());
    const key = inbox.snapshot().items[0].key;
    expect(inbox.mark([key], 'dismissed').items).toEqual([]);
    inbox.onLive(snapshot());
    expect(inbox.snapshot().items).toEqual([]);
    expect(inbox.snapshot(true).items.map((i) => i.state)).toEqual(['dismissed']);

    // The agent ran again and now waits again: a newer episode.
    now += 120_000;
    board = [liveRow({ sessionId: 'w', status: 'waiting', lastEvent: 'assistant-text', lastActivityMs: now })];
    inbox.onLive(snapshot());
    expect(inbox.snapshot().items.map((i) => i.state)).toEqual(['new']);

    // Undo is "mark as new".
    inbox.mark([key], 'dismissed');
    expect(inbox.mark([key], 'new').items.map((i) => i.state)).toEqual(['new']);
  });

  it('hides a snoozed item until its time, then brings it back through the timer', () => {
    const inbox = service();
    board = [liveRow({ sessionId: 'w', status: 'waiting', lastEvent: 'assistant-text' })];
    inbox.onLive(snapshot());
    const key = inbox.snapshot().items[0].key;
    expect(inbox.mark([key], 'snoozed', { untilMs: now + 900_000 }).items).toEqual([]);
    const armed = timers.filter((t) => !t.cancelled && t.ms !== INBOX_RECHECK_MS);
    expect(armed).toHaveLength(1);

    now += 900_001;
    armed[0].fn();
    expect(inbox.snapshot().items.map((i) => i.state)).toEqual(['new']);
    // A snooze without a future time is ignored rather than hiding the item forever.
    expect(inbox.mark([key], 'snoozed', { untilMs: now - 1 }).items).toHaveLength(1);
  });

  it('marks everything seen without undoing a dismiss, and records the visit', () => {
    now += 10_000;
    indexed = [row({ sessionId: 'a', endedAtMs: now - 2_000 }), row({ sessionId: 'b', endedAtMs: now - 1_000 })];
    const inbox = service();
    inbox.onIndexSettled();
    const [first] = inbox.snapshot().items;
    inbox.mark([first.key], 'dismissed');
    const after = inbox.mark('all', 'seen');
    expect(after.unread).toBe(0);
    expect(after.lastVisitMs).toBe(now);
    expect(inbox.snapshot(true).items.map((i) => i.state).sort()).toEqual(['dismissed', 'seen']);
  });

  it('treats a known permission request as exact, and a quiet tool call as a guess', () => {
    const inbox = service();
    board = [
      liveRow({ source: 'copilot-cli', sessionId: 'p', status: 'waiting', lastEvent: 'tool-pending', pendingTools: ['create'], exactPermission: true, lastActivityMs: now - LIVE_FINISHED_MS - 1 }),
      liveRow({ sessionId: 'g', status: 'working', lastEvent: 'tool-pending', pendingTools: ['Edit'], lastActivityMs: now - 5 * 60_000 }),
    ];
    inbox.onLive(snapshot());
    const items = inbox.snapshot().items;
    expect(items.map((i) => [i.sessionId, i.reason, i.exact])).toEqual([
      ['p', 'permission', true],
      ['g', 'permission-likely', false],
    ]);
  });

  it('notices a tool call that has gone quiet, even though the board announced nothing new', () => {
    const inbox = service();
    board = [liveRow({ sessionId: 'g', status: 'working', lastEvent: 'tool-pending', pendingTools: ['Edit'], lastActivityMs: now })];
    inbox.onLive(snapshot());
    expect(inbox.snapshot().items).toEqual([]);

    const recheck = timers.filter((t) => !t.cancelled && t.ms === INBOX_RECHECK_MS);
    expect(recheck).toHaveLength(1);
    now += 120_000;
    recheck[0].fn();
    recheck[0].cancelled = true; // it fired; the fake does not retire timers itself
    expect(inbox.snapshot().items.map((i) => i.reason)).toEqual(['permission-likely']);

    // Nothing live any more: no further rechecks are scheduled.
    board = [];
    inbox.onLive(snapshot());
    expect(timers.filter((t) => !t.cancelled && t.ms === INBOX_RECHECK_MS)).toEqual([]);
  });

  it('stores keys, enums and timestamps only', () => {
    indexed = [row({ sessionId: 'a', endedAtMs: now + 1, title: 'A very private title' })];
    board = [liveRow({ sessionId: 'w', status: 'waiting', lastEvent: 'assistant-text', title: 'Another private title', branch: 'feat/secret' })];
    const inbox = service();
    inbox.onLive(snapshot());
    const text = fs.readFileSync(path.join(dir, 'inbox.json'), 'utf8');
    expect(text).not.toContain('private title');
    expect(text).not.toContain('feat/secret');
    expect(text).not.toContain('github.com');
  });
});
