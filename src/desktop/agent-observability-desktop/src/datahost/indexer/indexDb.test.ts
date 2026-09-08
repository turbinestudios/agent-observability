import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { IndexDb } from './indexDb';
import type { SessionRow } from '../../shared/rpc';
import type { AnalyzedContextFile, SessionAnalysis } from '../analysis/sessionAnalyzer';
import type { RetrospectiveCounts } from '@agent-observability/core/src/analysis/retrospective';

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

/**
 * The date filter reads the END time — the column this list is ordered by and
 * the one the overview buckets its day columns by. Filtering on the start time
 * instead would make a chart column open a different set than it counted.
 */
describe('date range', () => {
  beforeEach(() => {
    db.upsertSessions([
      row({ sessionId: 'early', endedAtMs: 1_000 }),
      row({ sessionId: 'mid', endedAtMs: 5_000 }),
      row({ sessionId: 'late', endedAtMs: 9_000 }),
    ]);
  });

  it('narrows to sessions at or after a moment', () => {
    expect(db.listSessions({ endedAfterMs: 5_000 }).map((r) => r.sessionId)).toEqual(['late', 'mid']);
  });

  it('narrows to sessions at or before a moment', () => {
    expect(db.listSessions({ endedBeforeMs: 5_000 }).map((r) => r.sessionId)).toEqual(['mid', 'early']);
  });

  it('is inclusive at both ends, so a one-day range holds that day', () => {
    expect(
      db.listSessions({ endedAfterMs: 5_000, endedBeforeMs: 5_000 }).map((r) => r.sessionId),
    ).toEqual(['mid']);
  });

  it('combines with the source, repository and text filters', () => {
    db.upsertSessions([
      row({ sessionId: 'other-repo', endedAtMs: 6_000, repository: 'github.com/acme/other' }),
      row({ sessionId: 'copilot-one', endedAtMs: 6_000, source: 'copilot' }),
      row({ sessionId: 'titled', endedAtMs: 6_000, title: 'Fix the parser' }),
    ]);
    const inRange = { endedAfterMs: 5_000, endedBeforeMs: 9_000 };
    expect(db.listSessions({ ...inRange, source: 'copilot' }).map((r) => r.sessionId)).toEqual([
      'copilot-one',
    ]);
    expect(
      db.listSessions({ ...inRange, repository: 'github.com/acme/other' }).map((r) => r.sessionId),
    ).toEqual(['other-repo']);
    expect(db.listSessions({ ...inRange, query: 'parser' }).map((r) => r.sessionId)).toEqual([
      'titled',
    ]);
    // …and the range still bounds those narrower filters.
    expect(db.listSessions({ endedBeforeMs: 4_000, query: 'parser' })).toEqual([]);
  });

  it('counts exactly what it lists', () => {
    const params = { endedAfterMs: 5_000 };
    expect(db.countSessions(params)).toBe(db.listSessions(params).length);
  });
});

/**
 * Tags and user-chosen names live in JSON stores, not the index, so their keys
 * are passed INTO the query. Everything then happens in one statement —
 * filtering, ordering, LIMIT and OFFSET — which is what makes paging correct.
 */
describe('key overlays', () => {
  beforeEach(() => {
    db.upsertSessions([
      row({ sessionId: 'a', endedAtMs: 3_000, title: 'Original A' }),
      row({ sessionId: 'b', endedAtMs: 2_000, title: 'Original B' }),
      row({ sessionId: 'c', endedAtMs: 1_000, title: 'Original C' }),
    ]);
  });

  it('narrows the list to the tagged sessions', () => {
    const rows = db.listSessions({ tag: 'experiment-A' }, [], { restrictKeys: ['claude:a', 'claude:c'] });
    expect(rows.map((r) => r.sessionId)).toEqual(['a', 'c']);
  });

  it('selects nothing when the tag is on nothing, rather than everything', () => {
    expect(db.listSessions({ tag: 'unused' }, [], { restrictKeys: [] })).toEqual([]);
  });

  it('fails closed when a tag was never resolved to keys', () => {
    // A caller that forgot to resolve the tag must not be handed the whole
    // list — that would read as the tag matching every session.
    expect(db.listSessions({ tag: 'experiment-A' })).toEqual([]);
  });

  it('finds a session by the name the user gave it, which the index does not store', () => {
    const rows = db.listSessions({ query: 'renamed' }, [], { renameKeys: ['claude:b'] });
    expect(rows.map((r) => r.sessionId)).toEqual(['b']);
  });

  it('unions renamed matches with the text matches, in one ordered result', () => {
    const rows = db.listSessions({ query: 'Original A' }, [], { renameKeys: ['claude:c'] });
    expect(rows.map((r) => r.sessionId)).toEqual(['a', 'c']);
  });

  it('keeps a renamed match inside the other filters', () => {
    // The rename is an alternative way to MATCH, never a way to escape the
    // source, repository or date the user also asked for.
    expect(
      db.listSessions({ query: 'renamed', endedBeforeMs: 1_500 }, [], { renameKeys: ['claude:b'] }),
    ).toEqual([]);
  });

  it('pages a renamed match correctly, which a post-query union could not', () => {
    const overlay = { renameKeys: ['claude:c'] };
    const first = db.listSessions({ query: 'Original A', limit: 1 }, [], overlay);
    const second = db.listSessions({ query: 'Original A', limit: 1, offset: 1 }, [], overlay);
    expect(first.map((r) => r.sessionId)).toEqual(['a']);
    expect(second.map((r) => r.sessionId)).toEqual(['c']);
  });

  it('counts the same set the list returns', () => {
    const params = { query: 'Original A' };
    const overlay = { renameKeys: ['claude:c'] };
    expect(db.countSessions(params, [], overlay)).toBe(2);
    expect(db.countSessions({ tag: 't' }, [], { restrictKeys: ['claude:a'] })).toBe(1);
  });

  it('still excludes hidden sessions from a tagged list', () => {
    const rows = db.listSessions({ tag: 't' }, ['claude:a'], {
      restrictKeys: ['claude:a', 'claude:b'],
    });
    expect(rows.map((r) => r.sessionId)).toEqual(['b']);
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

describe('change-aware upserts', () => {
  const fingerprint = 'stable-source-and-wal';

  it('retains the revision and analysis when only the check time advances', () => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    db.upsertChangedSessions([original], fingerprint);
    db.putAnalysis('copilot', 'a', analysis({ deviationCount: 3 }), original.indexedAtMs, 9_000);

    expect(db.upsertChangedSessions([{ ...original, indexedAtMs: 10_000 }], fingerprint)).toEqual([]);
    expect(db.getRow('copilot', 'a')).toMatchObject({ indexedAtMs: 5_000, deviationCount: 3 });
    expect(db.staleAnalysis(5)).toEqual([]);
  });

  it('invalidates on source-only changes even when summaries are identical', () => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    db.upsertChangedSessions([original], fingerprint);
    db.putAnalysis('copilot', 'a', analysis(), original.indexedAtMs, 9_000);

    expect(db.upsertChangedSessions([{ ...original, indexedAtMs: 10_000 }], 'changed-wal')).toHaveLength(1);
    expect(db.staleAnalysis(5)).toEqual([{ source: 'copilot', sessionId: 'a', indexedAtMs: 10_000 }]);
  });

  it.each([
    { title: 'Updated title' },
    { titleDerived: true },
    { repository: 'github.com/acme/other' },
    { costMicros: 0 },
    { model: 'other-model' },
    { agentModes: ['ask'] },
  ])('does not hide metadata changes outside the source fingerprint: %j', (update) => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    db.upsertChangedSessions([original], fingerprint);
    expect(db.upsertChangedSessions([{ ...original, ...update, indexedAtMs: 10_000 }], fingerprint))
      .toHaveLength(1);
    expect(db.getRow('copilot', 'a')).toMatchObject({ ...update, indexedAtMs: 10_000 });
  });

  it('forces revalidation for an unknown or previously unrecorded fingerprint', () => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    // A pre-upgrade index has session rows but no change-token sidecar entries.
    db.upsertSessions([original]);
    expect(db.upsertChangedSessions([original], fingerprint)).toHaveLength(1);
    expect(db.upsertChangedSessions([original], undefined)).toHaveLength(1);
    expect(db.upsertChangedSessions([original], undefined)).toHaveLength(1);
    expect(db.upsertChangedSessions([original], fingerprint)).toHaveLength(1);
    expect(db.upsertChangedSessions([original], fingerprint)).toEqual([]);
  });

  it('advances a changed revision when the clock stands still or moves backward', () => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    db.upsertChangedSessions([original], fingerprint);
    const [sameTick] = db.upsertChangedSessions([original], 'next');
    const [backward] = db.upsertChangedSessions([{ ...original, indexedAtMs: 1 }], 'later');
    expect(sameTick.indexedAtMs).toBe(5_001);
    expect(backward.indexedAtMs).toBe(5_002);
  });

  it('replaces discovery placeholders with real values', () => {
    const original = row({ source: 'copilot', sessionId: 'a', pending: true, interactionCount: 0 });
    db.upsertChangedSessions([original], fingerprint);
    db.upsertChangedSessions([{ ...original, pending: false, interactionCount: 7 }], fingerprint);
    expect(db.getRow('copilot', 'a')?.interactionCount).toBe(7);
    expect(db.getRow('copilot', 'a')?.pending).toBeUndefined();
  });

  it('survives reopening the index without discarding analysis', () => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    db.upsertChangedSessions([original], fingerprint);
    db.putAnalysis('copilot', 'a', analysis(), original.indexedAtMs, 9_000);
    db.close();
    db = new IndexDb(dbPath);
    expect(db.upsertChangedSessions([{ ...original, indexedAtMs: 10_000 }], fingerprint)).toEqual([]);
    expect(db.analysisCounts()).toEqual({ total: 1, analyzed: 1 });
  });

  it('adds fingerprints to an existing index without rebuilding its rows or analysis', () => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    db.upsertSessions([original]);
    db.putAnalysis('copilot', 'a', analysis(), original.indexedAtMs, 9_000);
    db.close();
    const legacy = new Database(dbPath);
    legacy.exec('DROP TABLE session_fingerprints');
    legacy.close();

    db = new IndexDb(dbPath);
    expect(db.getRow('copilot', 'a')?.indexedAtMs).toBe(5_000);
    expect(db.analysisCounts()).toEqual({ total: 1, analyzed: 1 });
    // One refresh validates the source that an older index never fingerprinted.
    expect(db.upsertChangedSessions([original], fingerprint)).toHaveLength(1);
    expect(db.upsertChangedSessions([original], fingerprint)).toEqual([]);
  });

  it('rolls back rows and fingerprints together when a batch fails', () => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    db.upsertChangedSessions([original], fingerprint);
    const invalid = row({ source: 'copilot', sessionId: 'bad', repository: null as unknown as string });
    expect(() => db.upsertChangedSessions([{ ...original, title: 'new' }, invalid], 'changed'))
      .toThrow();
    expect(db.getRow('copilot', 'a')?.title).toBeUndefined();
    expect(db.upsertChangedSessions([original], fingerprint)).toEqual([]);
  });

  it.each(['clear', 'removeSession', 'removeMissing'] as const)('cleans fingerprints on %s', (operation) => {
    const original = row({ source: 'copilot', sessionId: 'a' });
    db.upsertChangedSessions([original], fingerprint);
    if (operation === 'clear') {
      db.clear();
    } else if (operation === 'removeSession') {
      db.removeSession('copilot', 'a');
    } else {
      db.removeMissing('copilot', new Set());
    }
    // Simulate an older writer re-inserting the same row. A forgotten token
    // would incorrectly classify this as unchanged instead of revalidating it.
    db.upsertSessions([original]);
    expect(db.upsertChangedSessions([original], fingerprint)).toHaveLength(1);
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

/** A stored analysis, with the file list defaulting to nothing in context. */
function analysis(over: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return { deviationCount: 0, errorCount: 0, findings: [], contextFiles: [], ...over };
}

/** One context file as the analyzer reports it. */
function file(over: Partial<AnalyzedContextFile> & Pick<AnalyzedContextFile, 'filePath'>): AnalyzedContextFile {
  return {
    name: path.basename(over.filePath ?? 'CLAUDE.md'),
    category: 'instruction',
    status: 'applied',
    estTokens: 100,
    ...over,
  };
}

describe('deviation counts on session rows', () => {
  it('carries the stored count onto the row, and leaves an unanalyzed session absent', () => {
    db.upsertSessions([row({ sessionId: 'flagged' }), row({ sessionId: 'unread' })]);
    db.putAnalysis('claude', 'flagged', analysis({ deviationCount: 3 }), 5_000, 9_000);

    const rows = db.listSessions({});
    expect(rows.find((r) => r.sessionId === 'flagged')?.deviationCount).toBe(3);
    // Not zero: nobody has looked at it yet, which is a different claim.
    expect(rows.find((r) => r.sessionId === 'unread')?.deviationCount).toBeUndefined();
    expect(db.getRow('claude', 'flagged')?.deviationCount).toBe(3);
  });

  it('narrows the list to flagged sessions, and counts them the same way', () => {
    db.upsertSessions([
      row({ sessionId: 'flagged' }),
      row({ sessionId: 'clean' }),
      row({ sessionId: 'unread' }),
    ]);
    db.putAnalysis('claude', 'flagged', analysis({ deviationCount: 1 }), 5_000, 9_000);
    db.putAnalysis('claude', 'clean', analysis(), 5_000, 9_000);

    expect(db.listSessions({ deviations: true }).map((r) => r.sessionId)).toEqual(['flagged']);
    expect(db.countSessions({ deviations: true })).toBe(1);
  });

  it('still applies the source and search filters alongside it', () => {
    db.upsertSessions([
      row({ sessionId: 'a', title: 'refactor' }),
      row({ sessionId: 'b', title: 'other', source: 'copilot' }),
    ]);
    db.putAnalysis('claude', 'a', analysis({ deviationCount: 2 }), 5_000, 9_000);
    db.putAnalysis('copilot', 'b', analysis({ deviationCount: 2 }), 5_000, 9_000);

    expect(db.listSessions({ deviations: true, source: 'copilot' }).map((r) => r.sessionId)).toEqual(['b']);
    expect(db.listSessions({ deviations: true, query: 'refactor' }).map((r) => r.sessionId)).toEqual(['a']);
  });

  it('drops every verdict when the threshold behind them changes, keeping context files', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    db.putAnalysis(
      'claude',
      'a',
      analysis({ deviationCount: 2, contextFiles: [file({ filePath: '/repo/CLAUDE.md' })] }),
      5_000,
      9_000,
    );

    db.clearDeviations();

    expect(db.getRow('claude', 'a')?.deviationCount).toBeUndefined();
    expect(db.hotspots()).toHaveLength(1);
    // And the session is queued to be read again.
    expect(db.staleAnalysis(10).map((t) => t.sessionId)).toEqual(['a']);
  });
});

describe('staleAnalysis', () => {
  it('offers sessions with no analysis, newest first', () => {
    db.upsertSessions([
      row({ sessionId: 'old', endedAtMs: 1_000 }),
      row({ sessionId: 'new', endedAtMs: 9_000 }),
    ]);
    expect(db.staleAnalysis(10).map((t) => t.sessionId)).toEqual(['new', 'old']);
  });

  it('stops offering a session once its analysis is pinned to the indexed row', () => {
    db.upsertSessions([row({ sessionId: 'a', indexedAtMs: 5_000 })]);
    db.putAnalysis('claude', 'a', analysis(), 5_000, 9_000);
    expect(db.staleAnalysis(10)).toHaveLength(0);

    // The transcript grew, so the indexer rewrote the row: the analysis is stale.
    db.upsertSessions([row({ sessionId: 'a', indexedAtMs: 6_000 })]);
    expect(db.staleAnalysis(10).map((t) => t.indexedAtMs)).toEqual([6_000]);
  });

  it('skips placeholders, whose counts are not parsed yet', () => {
    db.upsertSessions([row({ sessionId: 'a', pending: true })]);
    expect(db.staleAnalysis(10)).toHaveLength(0);
  });

  it('works forward from the newest sessions, so the window cannot be crowded out', () => {
    db.upsertSessions([
      row({ sessionId: 'old', endedAtMs: 1_000 }),
      row({ sessionId: 'new', endedAtMs: 9_000 }),
    ]);
    // A window of one covers only the newest session; the older one is out of
    // scope entirely rather than queued behind it.
    expect(db.staleAnalysis(10, 1).map((t) => t.sessionId)).toEqual(['new']);

    db.putAnalysis('claude', 'new', analysis(), 5_000, 9_000);
    expect(db.staleAnalysis(10, 1)).toHaveLength(0);
    expect(db.analysisCounts(1)).toEqual({ analyzed: 1, total: 1 });
  });

  it('caps a batch, so one tick cannot hold the thread', () => {
    db.upsertSessions([row({ sessionId: 'a' }), row({ sessionId: 'b' }), row({ sessionId: 'c' })]);
    expect(db.staleAnalysis(2)).toHaveLength(2);
  });
});

describe('hotspots', () => {
  beforeEach(() => {
    db.upsertSessions([
      row({ sessionId: 's1', endedAtMs: 3_000 }),
      row({ sessionId: 's2', endedAtMs: 2_000 }),
      row({ sessionId: 's3', endedAtMs: 1_000, repository: 'github.com/acme/other' }),
    ]);
    db.putAnalysis(
      'claude',
      's1',
      analysis({
        deviationCount: 1,
        errorCount: 2,
        contextFiles: [
          file({ filePath: '/repo/CLAUDE.md', estTokens: 900 }),
          file({ filePath: '/repo/.claude/skills/deploy.md', category: 'skill', estTokens: 300 }),
        ],
      }),
      5_000,
      9_000,
    );
    db.putAnalysis(
      'claude',
      's2',
      analysis({ contextFiles: [file({ filePath: '/repo/CLAUDE.md', estTokens: 2_500 })] }),
      5_000,
      9_000,
    );
    db.putAnalysis(
      'claude',
      's3',
      analysis({ contextFiles: [file({ filePath: '/other/CLAUDE.md', estTokens: 100 })] }),
      5_000,
      9_000,
    );
  });

  it('ranks files by contributing sessions, then by weight', () => {
    // CLAUDE.md leads on two sessions; the other two tie on one apiece, so the
    // heavier of them (300 estimated tokens against 100) comes first.
    expect(db.hotspots().map((h) => h.file)).toEqual([
      '/repo/CLAUDE.md',
      '/repo/.claude/skills/deploy.md',
      '/other/CLAUDE.md',
    ]);
  });

  it('reports the heaviest single session, not the average — that is what oversize means', () => {
    const top = db.hotspots()[0];
    expect(top.sessionCount).toBe(2);
    expect(top.appliedCount).toBe(2);
    expect(top.estTokensMax).toBe(2_500);
    expect(top.lastSeenMs).toBe(3_000);
  });

  it('counts error and deviation co-occurrence per session', () => {
    const top = db.hotspots()[0];
    expect(top.errorSessions).toBe(1);
    expect(top.deviationSessions).toBe(1);
  });

  it('separates applied, skipped, and tool-read appearances', () => {
    db.upsertSessions([row({ sessionId: 's4', endedAtMs: 4_000 })]);
    db.putAnalysis(
      'claude',
      's4',
      analysis({
        contextFiles: [
          file({ filePath: '/repo/skip.md', status: 'skipped', estTokens: 0 }),
          file({ filePath: '/repo/read.md', status: 'read' }),
        ],
      }),
      5_000,
      9_000,
    );

    const byFile = new Map(db.hotspots().map((h) => [h.file, h]));
    expect(byFile.get('/repo/skip.md')?.skippedCount).toBe(1);
    expect(byFile.get('/repo/skip.md')?.appliedCount).toBe(0);
    expect(byFile.get('/repo/read.md')?.readCount).toBe(1);
  });

  it('narrows to one repository', () => {
    expect(db.hotspots({ repository: 'github.com/acme/other' }).map((h) => h.file)).toEqual([
      '/other/CLAUDE.md',
    ]);
    expect(db.hotspotRepositories()).toEqual(['github.com/acme/app', 'github.com/acme/other']);
  });

  it('leaves out sessions the user removed from their list', () => {
    expect(db.hotspots({}, ['claude:s2'])[0].sessionCount).toBe(1);
  });

  it('lists the sessions behind a file, newest first, with their signals', () => {
    const sessions = db.hotspotSessions('/repo/CLAUDE.md');
    expect(sessions.map((s) => s.sessionId)).toEqual(['s1', 's2']);
    expect(sessions[0]).toMatchObject({ hadError: true, hadDeviation: true, status: 'applied' });
    expect(sessions[1]).toMatchObject({ hadError: false, hadDeviation: false, estTokens: 2_500 });
  });

  it('rewrites a session wholesale, so a file that left context leaves the ranking', () => {
    db.putAnalysis('claude', 's1', analysis({ contextFiles: [file({ filePath: '/repo/CLAUDE.md' })] }), 5_000, 9_000);
    expect(db.hotspots().map((h) => h.file)).not.toContain('/repo/.claude/skills/deploy.md');
  });

  it('forgets a deleted session entirely, ranking included', () => {
    db.removeSession('claude', 's1');
    expect(db.hotspots().map((h) => h.file)).not.toContain('/repo/.claude/skills/deploy.md');
    expect(db.staleAnalysis(10).map((t) => t.sessionId)).not.toContain('s1');
  });

  it('forgets sessions whose files are gone, ranking included', () => {
    db.removeMissing('claude', new Set(['s2', 's3']));
    expect(db.hotspots().map((h) => h.file)).not.toContain('/repo/.claude/skills/deploy.md');
  });
});

describe('windowed hotspots', () => {
  it('excludes sessions ending before the cutoff, leaving unwindowed calls whole', () => {
    const now = Date.now();
    db.upsertSessions([
      row({ sessionId: 'recent', endedAtMs: now }),
      row({ sessionId: 'ancient', endedAtMs: 1_000 }),
    ]);
    for (const id of ['recent', 'ancient']) {
      db.putAnalysis(
        'claude',
        id,
        analysis({ contextFiles: [file({ filePath: '/repo/CLAUDE.md' })] }),
        5_000,
        9_000,
      );
    }

    expect(db.hotspots({ endedAfterMs: now - 1_000 })[0].sessionCount).toBe(1);
    expect(db.hotspots()[0].sessionCount).toBe(2);
  });
});

describe('schema version', () => {
  it('drops and rebuilds an index written by an older version, analysis included', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    db.putAnalysis(
      'claude',
      'a',
      analysis({
        deviationCount: 2,
        findings: [{ id: 'correction-reprompt', severity: 'friction', count: 1 }],
      }),
      5_000,
      9_000,
    );
    db.close();

    // Pose as an index left behind by an earlier release. Reopening must rebuild
    // rather than read rows whose shape it no longer understands — the whole
    // point of treating index.db as a disposable cache.
    const raw = new Database(dbPath);
    raw.prepare(`UPDATE meta SET value = '0' WHERE key = 'schema_version'`).run();
    raw.close();

    db = new IndexDb(dbPath);

    expect(db.listSessions({})).toHaveLength(0);
    expect(db.hotspots()).toHaveLength(0);
    expect(db.insights('all').themes).toHaveLength(0);
    expect(db.analysisCounts()).toEqual({ analyzed: 0, total: 0 });
    // And it is usable again immediately, not left half-dropped.
    db.upsertSessions([row({ sessionId: 'b' })]);
    expect(db.staleAnalysis(10).map((t) => t.sessionId)).toEqual(['b']);
  });
});

/** A retro counts projection with every number zeroed, for overriding. */
function retroCounts(over: Partial<RetrospectiveCounts> = {}): RetrospectiveCounts {
  return {
    verdict: 'smooth',
    outcome: 'unclear',
    correctionTurns: 0,
    repeatedPromptTurns: 0,
    interruptions: 0,
    errorStreaks: 0,
    maxErrorStreak: 0,
    longTailTurns: 0,
    compactions: 0,
    churnRatioPct: 0,
    planModeUsed: false,
    tipCount: 0,
    ...over,
  };
}

describe('retrospective verdicts', () => {
  it('carries the stored verdict onto the row, and leaves an unjudged session absent', () => {
    db.upsertSessions([row({ sessionId: 'rough' }), row({ sessionId: 'unread' }), row({ sessionId: 'broken' })]);
    db.putAnalysis('claude', 'rough', analysis({ retro: retroCounts({ verdict: 'struggled' }) }), 5_000, 9_000);
    // An analysis whose retrospective could not be built stores NULL, which
    // must read back as absent — never as smooth.
    db.putAnalysis('claude', 'broken', analysis(), 5_000, 9_000);

    const rows = db.listSessions({});
    expect(rows.find((r) => r.sessionId === 'rough')?.verdict).toBe('struggled');
    expect(rows.find((r) => r.sessionId === 'unread')?.verdict).toBeUndefined();
    expect(rows.find((r) => r.sessionId === 'broken')?.verdict).toBeUndefined();
  });

  it('narrows the list to struggled and abandoned sessions only', () => {
    db.upsertSessions([
      row({ sessionId: 'struggled' }),
      row({ sessionId: 'gone' }),
      row({ sessionId: 'fine' }),
      row({ sessionId: 'unjudged' }),
    ]);
    db.putAnalysis('claude', 'struggled', analysis({ retro: retroCounts({ verdict: 'struggled' }) }), 5_000, 9_000);
    db.putAnalysis('claude', 'gone', analysis({ retro: retroCounts({ verdict: 'abandoned' }) }), 5_000, 9_000);
    db.putAnalysis('claude', 'fine', analysis({ retro: retroCounts({ verdict: 'bumpy' }) }), 5_000, 9_000);
    db.putAnalysis('claude', 'unjudged', analysis(), 5_000, 9_000);

    expect(
      db
        .listSessions({ friction: true })
        .map((r) => r.sessionId)
        .sort(),
    ).toEqual(['gone', 'struggled']);
    expect(db.countSessions({ friction: true })).toBe(2);
  });
});

describe('session findings', () => {
  it('rewrites a session\'s findings wholesale on re-analysis', () => {
    db.upsertSessions([row({ sessionId: 'a', endedAtMs: Date.now() })]);
    db.putAnalysis(
      'claude',
      'a',
      analysis({
        findings: [
          { id: 'correction-reprompt', severity: 'friction', count: 2 },
          { id: 'tool-error-streak', severity: 'blocker', count: 1 },
        ],
      }),
      5_000,
      9_000,
    );
    // The re-analysis no longer raises the error streak: it must leave the
    // themes, not linger in them.
    db.putAnalysis(
      'claude',
      'a',
      analysis({ findings: [{ id: 'correction-reprompt', severity: 'friction', count: 3 }] }),
      5_000,
      9_500,
    );

    const { themes } = db.insights('all');
    expect(themes).toEqual([{ signalId: 'correction-reprompt', sessions: 1, occurrences: 3 }]);
  });

  it('drops findings with their session, and on clear and clearDeviations', () => {
    db.upsertSessions([row({ sessionId: 'a', endedAtMs: Date.now() })]);
    const flagged = analysis({ findings: [{ id: 'rework-churn', severity: 'friction', count: 1 }] });

    db.putAnalysis('claude', 'a', flagged, 5_000, 9_000);
    db.removeSession('claude', 'a');
    expect(db.insights('all').themes).toHaveLength(0);

    db.upsertSessions([row({ sessionId: 'a', endedAtMs: Date.now() })]);
    db.putAnalysis('claude', 'a', flagged, 5_000, 9_000);
    db.clearDeviations();
    expect(db.insights('all').themes).toHaveLength(0);

    db.putAnalysis('claude', 'a', flagged, 5_000, 9_000);
    db.clear();
    expect(db.insights('all').themes).toHaveLength(0);
  });

  it('ranks themes by sessions affected, then occurrences, and excludes info severity', () => {
    const now = Date.now();
    db.upsertSessions([
      row({ sessionId: 'a', endedAtMs: now }),
      row({ sessionId: 'b', endedAtMs: now }),
      row({ sessionId: 'c', endedAtMs: now }),
    ]);
    db.putAnalysis(
      'claude',
      'a',
      analysis({
        findings: [
          { id: 'correction-reprompt', severity: 'friction', count: 1 },
          { id: 'rework-churn', severity: 'friction', count: 5 },
          { id: 'plan-mode-skipped', severity: 'info', count: 1 },
        ],
      }),
      5_000,
      9_000,
    );
    db.putAnalysis(
      'claude',
      'b',
      analysis({ findings: [{ id: 'correction-reprompt', severity: 'blocker', count: 2 }] }),
      5_000,
      9_000,
    );
    db.putAnalysis(
      'claude',
      'c',
      analysis({ findings: [{ id: 'plan-mode-skipped', severity: 'info', count: 4 }] }),
      5_000,
      9_000,
    );

    const { themes } = db.insights('all');
    expect(themes).toEqual([
      { signalId: 'correction-reprompt', sessions: 2, occurrences: 3 },
      { signalId: 'rework-churn', sessions: 1, occurrences: 5 },
    ]);
  });

  it('windows themes by session end time and respects hidden keys', () => {
    const now = Date.now();
    db.upsertSessions([
      row({ sessionId: 'recent', endedAtMs: now }),
      row({ sessionId: 'ancient', endedAtMs: 1_000 }),
      row({ sessionId: 'hidden', endedAtMs: now }),
    ]);
    for (const id of ['recent', 'ancient', 'hidden']) {
      db.putAnalysis(
        'claude',
        id,
        analysis({ findings: [{ id: 'repeated-prompt', severity: 'friction', count: 1 }] }),
        5_000,
        9_000,
      );
    }

    expect(db.insights(7, ['claude:hidden']).themes).toEqual([
      { signalId: 'repeated-prompt', sessions: 1, occurrences: 1 },
    ]);
    expect(db.insights('all').themes[0].sessions).toBe(3);
  });

  it('narrows the session list to a finding signal, failing closed on info-only', () => {
    db.upsertSessions([
      row({ sessionId: 'raised' }),
      row({ sessionId: 'info-only' }),
      row({ sessionId: 'clean' }),
    ]);
    db.putAnalysis(
      'claude',
      'raised',
      analysis({ findings: [{ id: 'vague-first-prompt', severity: 'friction', count: 1 }] }),
      5_000,
      9_000,
    );
    db.putAnalysis(
      'claude',
      'info-only',
      analysis({ findings: [{ id: 'vague-first-prompt', severity: 'info', count: 1 }] }),
      5_000,
      9_000,
    );
    db.putAnalysis('claude', 'clean', analysis(), 5_000, 9_000);

    expect(db.listSessions({ signal: 'vague-first-prompt' }).map((r) => r.sessionId)).toEqual(['raised']);
    expect(db.countSessions({ signal: 'vague-first-prompt' })).toBe(1);
    expect(db.listSessions({ signal: 'no-such-signal' })).toEqual([]);
  });

  it('narrows the session list to one exact verdict', () => {
    db.upsertSessions([row({ sessionId: 'rough' }), row({ sessionId: 'fine' }), row({ sessionId: 'unjudged' })]);
    db.putAnalysis('claude', 'rough', analysis({ retro: retroCounts({ verdict: 'bumpy' }) }), 5_000, 9_000);
    db.putAnalysis('claude', 'fine', analysis({ retro: retroCounts() }), 5_000, 9_000);
    db.putAnalysis('claude', 'unjudged', analysis(), 5_000, 9_000);

    expect(db.listSessions({ verdict: 'bumpy' }).map((r) => r.sessionId)).toEqual(['rough']);
    // A NULL verdict is "not judged" and passes no exact-verdict filter.
    expect(db.countSessions({ verdict: 'smooth' })).toBe(1);
  });
});

describe('insights verdict trend', () => {
  it('buckets every session — judged, unjudgeable, and unanalyzed — so days sum to the daily chart', () => {
    const now = Date.now();
    db.upsertSessions([
      row({ sessionId: 'smooth', endedAtMs: now }),
      row({ sessionId: 'rough', endedAtMs: now }),
      row({ sessionId: 'broken', endedAtMs: now }),
      row({ sessionId: 'unread', endedAtMs: now }),
    ]);
    db.putAnalysis('claude', 'smooth', analysis({ retro: retroCounts() }), 5_000, 9_000);
    db.putAnalysis('claude', 'rough', analysis({ retro: retroCounts({ verdict: 'struggled' }) }), 5_000, 9_000);
    // Analyzed but unjudgeable: NULL verdict must land in 'unjudged', never 'smooth'.
    db.putAnalysis('claude', 'broken', analysis(), 5_000, 9_000);

    const { verdictDaily } = db.insights(7);
    const byVerdict = new Map(verdictDaily.map((p) => [p.verdict, p.sessions]));
    expect(byVerdict.get('smooth')).toBe(1);
    expect(byVerdict.get('struggled')).toBe(1);
    expect(byVerdict.get('unjudged')).toBe(2);

    // The invariant the hero chart depends on: per-day sums equal the overview's
    // daily session counts, computed by the very same SQL bucketing.
    const overviewByDay = new Map<string, number>();
    for (const point of db.overview(7).daily) {
      overviewByDay.set(point.day, (overviewByDay.get(point.day) ?? 0) + point.sessions);
    }
    const insightsByDay = new Map<string, number>();
    for (const point of verdictDaily) {
      insightsByDay.set(point.day, (insightsByDay.get(point.day) ?? 0) + point.sessions);
    }
    expect(insightsByDay).toEqual(overviewByDay);
  });

  it('excludes hidden sessions', () => {
    const now = Date.now();
    db.upsertSessions([row({ sessionId: 'kept', endedAtMs: now }), row({ sessionId: 'hidden', endedAtMs: now })]);
    const { verdictDaily } = db.insights(7, ['claude:hidden']);
    expect(verdictDaily.reduce((sum, p) => sum + p.sessions, 0)).toBe(1);
  });
});

describe('retro ranking', () => {
  it('orders worst verdict tier first, most recent first within a tier', () => {
    db.upsertSessions([
      row({ sessionId: 'smooth-new', endedAtMs: 9_000 }),
      row({ sessionId: 'gone-old', endedAtMs: 1_000 }),
      row({ sessionId: 'rough-new', endedAtMs: 8_000 }),
      row({ sessionId: 'rough-old', endedAtMs: 2_000 }),
      row({ sessionId: 'unjudged', endedAtMs: 9_500 }),
    ]);
    db.putAnalysis('claude', 'smooth-new', analysis({ retro: retroCounts() }), 5_000, 9_000);
    db.putAnalysis('claude', 'gone-old', analysis({ retro: retroCounts({ verdict: 'abandoned' }) }), 5_000, 9_000);
    db.putAnalysis('claude', 'rough-new', analysis({ retro: retroCounts({ verdict: 'struggled', correctionTurns: 3 }) }), 5_000, 9_000);
    db.putAnalysis('claude', 'rough-old', analysis({ retro: retroCounts({ verdict: 'struggled' }) }), 5_000, 9_000);
    db.putAnalysis('claude', 'unjudged', analysis(), 5_000, 9_000);

    const result = db.retro();
    expect(result.rows.map((r) => r.sessionId)).toEqual([
      'gone-old',
      'rough-new',
      'rough-old',
      'smooth-new',
    ]);
    // The counts ride along for the table's friction column.
    expect(result.rows[1].correctionTurns).toBe(3);
    expect(result.repositories).toEqual(['github.com/acme/app']);
  });

  it('excludes hidden sessions and honours the repository filter', () => {
    db.upsertSessions([
      row({ sessionId: 'kept' }),
      row({ sessionId: 'hidden' }),
      row({ sessionId: 'elsewhere', repository: 'github.com/acme/other' }),
    ]);
    for (const id of ['kept', 'hidden', 'elsewhere']) {
      db.putAnalysis('claude', id, analysis({ retro: retroCounts({ verdict: 'bumpy' }) }), 5_000, 9_000);
    }

    const filtered = db.retro({ repository: 'github.com/acme/app' }, ['claude:hidden']);
    expect(filtered.rows.map((r) => r.sessionId)).toEqual(['kept']);
    expect(filtered.repositories).toEqual(['github.com/acme/app']);
  });
});
