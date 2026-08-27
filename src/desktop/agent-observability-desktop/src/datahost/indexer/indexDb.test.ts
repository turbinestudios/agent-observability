import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IndexDb } from './indexDb';
import type { SessionRow } from '../../shared/rpc';

/**
 * Index behavior that the UI depends on: ordering, filtering, and — most
 * importantly — that a discovery placeholder can never overwrite counts that
 * were already parsed. Getting that wrong would make hydrated rows silently
 * revert to zeros on the next refresh.
 */

let dbPath: string;
let db: IndexDb;

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: 'github.com/acme/app',
    startedAtMs: 1_000,
    endedAtMs: 2_000,
    durationMs: 1_000,
    interactionCount: 10,
    llmCalls: 4,
    toolCalls: 6,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 25,
    model: 'claude-sonnet-4',
    agentModes: ['agent'],
    indexedAtMs: 5_000,
    ...over,
  };
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `ao-index-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  db = new IndexDb(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});

describe('listSessions', () => {
  it('returns rows newest-first', () => {
    db.upsertSessions([
      row({ sessionId: 'old', endedAtMs: 1_000 }),
      row({ sessionId: 'new', endedAtMs: 9_000 }),
      row({ sessionId: 'mid', endedAtMs: 5_000 }),
    ]);
    expect(db.listSessions({}).map((r) => r.sessionId)).toEqual(['new', 'mid', 'old']);
  });

  it('filters by source and repository', () => {
    db.upsertSessions([
      row({ sessionId: 'a', repository: 'github.com/acme/app' }),
      row({ sessionId: 'b', repository: 'github.com/acme/other' }),
      row({ sessionId: 'c', source: 'copilot', repository: 'github.com/acme/third' }),
    ]);
    expect(db.listSessions({ repository: 'github.com/acme/app' }).map((r) => r.sessionId)).toEqual(['a']);
    expect(db.listSessions({ source: 'copilot' }).map((r) => r.sessionId)).toEqual(['c']);
    expect(db.listSessions({ source: 'claude' }).map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
  });

  it('matches a query against title, repository, and id', () => {
    db.upsertSessions([
      row({ sessionId: 'a', title: 'Fix the login bug' }),
      row({ sessionId: 'b', title: 'Add telemetry', repository: 'github.com/acme/login-svc' }),
      row({ sessionId: 'unrelated-c', title: 'Something else', repository: 'github.com/acme/zzz' }),
    ]);
    expect(db.listSessions({ query: 'login' }).map((r) => r.sessionId).sort()).toEqual(['a', 'b']);
    expect(db.listSessions({ query: 'unrelated' }).map((r) => r.sessionId)).toEqual(['unrelated-c']);
  });

  it('treats % and _ in a query as literal characters, not wildcards', () => {
    db.upsertSessions([
      row({ sessionId: 'a', title: '100% done' }),
      row({ sessionId: 'b', title: 'anything at all' }),
    ]);
    expect(db.listSessions({ query: '100%' }).map((r) => r.sessionId)).toEqual(['a']);
  });

  it('pages with limit and offset', () => {
    db.upsertSessions([1, 2, 3, 4, 5].map((n) => row({ sessionId: `s${n}`, endedAtMs: n * 1000 })));
    expect(db.listSessions({ limit: 2 }).map((r) => r.sessionId)).toEqual(['s5', 's4']);
    expect(db.listSessions({ limit: 2, offset: 2 }).map((r) => r.sessionId)).toEqual(['s3', 's2']);
  });

  it('caps an unreasonable limit rather than returning the whole table', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    expect(() => db.listSessions({ limit: 10_000_000 })).not.toThrow();
  });
});

describe('placeholder rows', () => {
  it('does not overwrite parsed counts when a placeholder is written again', () => {
    db.upsertSessions([row({ sessionId: 'a', interactionCount: 42, title: 'Real title', pending: false })]);

    // A later discovery pass re-announces the session with no parsed data.
    db.upsertSessions([
      row({
        sessionId: 'a',
        interactionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        title: undefined,
        model: 'unknown',
        pending: true,
      }),
    ]);

    const stored = db.getRow('claude', 'a');
    expect(stored?.interactionCount).toBe(42);
    expect(stored?.title).toBe('Real title');
    expect(stored?.pending).toBeUndefined();
  });

  it('lets a hydrated row replace a placeholder', () => {
    db.upsertSessions([row({ sessionId: 'a', interactionCount: 0, pending: true })]);
    db.upsertSessions([row({ sessionId: 'a', interactionCount: 7, pending: false })]);

    const stored = db.getRow('claude', 'a');
    expect(stored?.interactionCount).toBe(7);
    expect(stored?.pending).toBeUndefined();
  });

  it('counts placeholders as known but not yet indexed', () => {
    db.upsertSessions([
      row({ sessionId: 'a', pending: true }),
      row({ sessionId: 'b', pending: false }),
    ]);
    expect(db.counts()).toEqual({ total: 2, indexed: 1 });
  });
});

describe('groups', () => {
  it('counts sessions per source and repository, newest group first', () => {
    db.upsertSessions([
      row({ sessionId: 'a', repository: 'r1', endedAtMs: 1_000 }),
      row({ sessionId: 'b', repository: 'r1', endedAtMs: 3_000 }),
      row({ sessionId: 'c', repository: 'r2', endedAtMs: 9_000 }),
    ]);
    const groups = db.listGroups();
    expect(groups[0]).toMatchObject({ repository: 'r2', count: 1, newestMs: 9_000 });
    expect(groups[1]).toMatchObject({ repository: 'r1', count: 2, newestMs: 3_000 });
  });
});

describe('removeMissing', () => {
  it('drops sessions whose files are gone and reports their keys', () => {
    db.upsertSessions([row({ sessionId: 'keep' }), row({ sessionId: 'gone' })]);
    const removed = db.removeMissing('claude', new Set(['keep']));
    expect(removed).toEqual(['claude:gone']);
    expect(db.listSessions({}).map((r) => r.sessionId)).toEqual(['keep']);
  });

  it('leaves other sources untouched', () => {
    db.upsertSessions([row({ sessionId: 'a', source: 'copilot' }), row({ sessionId: 'b' })]);
    db.removeMissing('claude', new Set());
    expect(db.listSessions({}).map((r) => r.sessionId)).toEqual(['a']);
  });
});

describe('file state', () => {
  it('round-trips the fingerprint used to skip unchanged files', () => {
    db.putFileState({
      path: '/tmp/a.jsonl',
      source: 'claude',
      sessionId: 'a',
      kind: 'main',
      size: 1234,
      mtimeMs: 99.5,
      headHash: 'abc',
      parsedBytes: 1234,
      accState: null,
    });
    expect(db.getFileState('/tmp/a.jsonl')).toMatchObject({ size: 1234, mtimeMs: 99.5, headHash: 'abc' });
  });

  it('reports nothing for a file it has never seen', () => {
    expect(db.getFileState('/tmp/never.jsonl')).toBeUndefined();
  });
});

describe('repository cache', () => {
  it('round-trips a resolved remote', () => {
    db.putCachedRepository('/work/app', 'github.com/acme/app', 1);
    expect(db.getCachedRepository('/work/app')).toBe('github.com/acme/app');
  });
});

describe('clear', () => {
  it('empties the index so it can be rebuilt from disk', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    db.clear();
    expect(db.listSessions({})).toEqual([]);
    expect(db.counts()).toEqual({ total: 0, indexed: 0 });
  });
});
