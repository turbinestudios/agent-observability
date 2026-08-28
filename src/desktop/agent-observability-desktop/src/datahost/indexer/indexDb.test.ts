import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { IndexDb } from './indexDb';
import type { SessionRow } from '../../shared/rpc';
import type { AnalyzedContextFile, SessionAnalysis } from '../analysis/sessionAnalyzer';

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

/** A stored analysis, with the file list defaulting to nothing in context. */
function analysis(over: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return { deviationCount: 0, errorCount: 0, contextFiles: [], ...over };
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

describe('schema version', () => {
  it('drops and rebuilds an index written by an older version, analysis included', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    db.putAnalysis('claude', 'a', analysis({ deviationCount: 2 }), 5_000, 9_000);
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
    expect(db.analysisCounts()).toEqual({ analyzed: 0, total: 0 });
    // And it is usable again immediately, not left half-dropped.
    db.upsertSessions([row({ sessionId: 'b' })]);
    expect(db.staleAnalysis(10).map((t) => t.sessionId)).toEqual(['b']);
  });
});
