import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { IndexDb } from './indexDb';
import type { SessionRow } from '../../shared/rpc';
import type { SessionAnalysis } from '../analysis/sessionAnalyzer';

/**
 * The Evidence foundation in the index: the per-tool table, the analysis
 * version that re-runs only the analysis pass, and the tool filter. Everything
 * runs against a temp database; times are plain numbers, never formatted.
 */

let dbPath: string;
let db: IndexDb;

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: 'r1',
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

function analysis(over: Partial<SessionAnalysis> = {}): SessionAnalysis {
  return { deviationCount: 0, errorCount: 0, findings: [], contextFiles: [], ...over };
}

/** One tool as the analyzer folds it: every call in the fastest bucket. */
function tool(name: string, calls: number, failures: number): NonNullable<SessionAnalysis['tools']>[number] {
  return { name, calls, failures, durationMsSum: calls * 50, durationMsMax: 50, buckets: [calls, 0, 0, 0, 0, 0, 0, 0, 0] };
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `ao-evidence-test-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  db = new IndexDb(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});

describe('evidence tables and the analysis version', () => {
  it('creates the evidence tables and empties them on clear', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    db.putAnalysis('claude', 'a', analysis({ tools: [tool('Bash', 2, 1)] }), 5_000, 9_000);
    expect(db.toolRanking().map((r) => r.tool)).toEqual(['Bash']);

    db.clear();
    expect(db.toolRanking()).toEqual([]);

    const raw = new Database(dbPath, { readonly: true });
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    raw.close();
    expect(tables).toEqual(expect.arrayContaining(['session_tools', 'session_file_edits']));
  });

  it('wipes only the analysis when the analysis version moved, and only once', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    db.putAnalysis('claude', 'a', analysis({ deviationCount: 2, tools: [tool('Bash', 1, 0)] }), 5_000, 9_000);
    db.close();

    const raw = new Database(dbPath);
    raw.prepare("UPDATE meta SET value = '0' WHERE key = 'analysis_version'").run();
    raw.close();

    db = new IndexDb(dbPath);
    // The session row survives: nothing is re-indexed.
    expect(db.listSessions({}).map((r) => r.sessionId)).toEqual(['a']);
    expect(db.listSessions({})[0].deviationCount).toBeUndefined();
    expect(db.toolRanking()).toEqual([]);
    expect(db.staleAnalysis(10).map((t) => t.sessionId)).toEqual(['a']);

    // With the version current again, a reopen leaves fresh analysis alone.
    db.putAnalysis('claude', 'a', analysis({ tools: [tool('Bash', 1, 0)] }), 5_000, 9_000);
    db.close();
    db = new IndexDb(dbPath);
    expect(db.toolRanking()).toHaveLength(1);
  });

  it('rewrites tool rows wholesale and removes them with the session', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    db.putAnalysis('claude', 'a', analysis({ tools: [tool('Bash', 2, 0), tool('Read', 1, 0)] }), 5_000, 9_000);
    db.putAnalysis('claude', 'a', analysis({ tools: [tool('Read', 4, 0)] }), 5_000, 9_000);
    expect(db.toolRanking().map((r) => [r.tool, r.calls])).toEqual([['Read', 4]]);
    // An analysis without tool data records none.
    db.putAnalysis('claude', 'a', analysis(), 5_000, 9_000);
    expect(db.toolRanking()).toEqual([]);
    db.putAnalysis('claude', 'a', analysis({ tools: [tool('Read', 1, 0)] }), 5_000, 9_000);
    db.removeSession('claude', 'a');
    expect(db.toolRanking()).toEqual([]);
  });
});

describe('toolRanking and the tool filter', () => {
  beforeEach(() => {
    db.upsertSessions([
      row({ sessionId: 'a', repository: 'r1', endedAtMs: 5_000 }),
      row({ sessionId: 'b', repository: 'r2', endedAtMs: 9_000 }),
    ]);
    db.putAnalysis('claude', 'a', analysis({ tools: [tool('Bash', 2, 1)] }), 5_000, 9_000);
    db.putAnalysis('claude', 'b', analysis({ tools: [tool('Bash', 3, 0), tool('Read', 1, 0)] }), 5_000, 9_000);
  });

  it('folds calls, failures, sessions and last use per tool, busiest first', () => {
    const [bash, read] = db.toolRanking();
    expect(bash).toMatchObject({ tool: 'Bash', calls: 5, failures: 1, sessions: 2, lastUsedMs: 9_000, p90Overflow: false });
    expect(bash.p50Ms).toBe(bash.p90Ms);
    expect(read).toMatchObject({ tool: 'Read', calls: 1, failures: 0, sessions: 1 });
  });

  it('narrows by repository, end time, source and the hidden set', () => {
    expect(db.toolRanking({ repository: 'r1' }).map((r) => [r.tool, r.calls])).toEqual([['Bash', 2]]);
    expect(db.toolRanking({ endedAfterMs: 6_000 }).map((r) => [r.tool, r.calls])).toEqual([
      ['Bash', 3],
      ['Read', 1],
    ]);
    expect(db.toolRanking({ source: 'copilot' })).toEqual([]);
    expect(db.toolRanking({}, ['claude:b']).map((r) => [r.tool, r.calls])).toEqual([['Bash', 2]]);
  });

  it('filters the session list by tool, and by where it failed', () => {
    expect(db.listSessions({ tool: 'Bash' }).map((r) => r.sessionId)).toEqual(['b', 'a']);
    expect(db.listSessions({ tool: 'Bash', toolFailed: true }).map((r) => r.sessionId)).toEqual(['a']);
    expect(db.listSessions({ tool: 'Read' }).map((r) => r.sessionId)).toEqual(['b']);
    expect(db.countSessions({ tool: 'Nope' })).toBe(0);
    // The failed flag alone is not a filter.
    expect(db.countSessions({ toolFailed: true })).toBe(2);
  });
});
