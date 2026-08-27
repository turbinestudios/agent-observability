import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { IndexDb, TOP_REPOSITORY_LIMIT } from './indexDb';
import type { SessionRow } from '../../shared/rpc';

/**
 * The overview aggregation.
 *
 * Every number here is read straight off the index, which is what lets the view
 * open instantly. The parts worth pinning are the ones a plain SUM would get
 * subtly wrong: distinct counts that must ignore the `unknown` placeholder, an
 * average that must not be dragged down by sessions with no recorded duration,
 * and a daily series that must bucket by local day and stay inside its window.
 */

let dbPath: string;
let db: IndexDb;

const DAY_MS = 86_400_000;

function row(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: 'github.com/acme/app',
    startedAtMs: 1_000,
    endedAtMs: Date.now(),
    durationMs: 60_000,
    interactionCount: 10,
    llmCalls: 4,
    toolCalls: 6,
    inputTokens: 100,
    outputTokens: 50,
    cachedTokens: 25,
    model: 'claude-sonnet-4',
    agentModes: [],
    indexedAtMs: 1,
    ...over,
  };
}

/** Local-day key, matching the SQL's `localtime` grouping. */
function isoDay(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

beforeEach(() => {
  dbPath = path.join(os.tmpdir(), `ao-overview-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  db = new IndexDb(dbPath);
});

afterEach(() => {
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});

describe('totals', () => {
  it('sums counts and tokens across every session', () => {
    db.upsertSessions([
      row({ sessionId: 'a', interactionCount: 10, inputTokens: 100, outputTokens: 50, cachedTokens: 25 }),
      row({ sessionId: 'b', interactionCount: 5, inputTokens: 20, outputTokens: 10, cachedTokens: 5 }),
    ]);

    const { totals } = db.overview(30);
    expect(totals.sessions).toBe(2);
    expect(totals.steps).toBe(15);
    expect(totals.inputTokens).toBe(120);
    expect(totals.outputTokens).toBe(60);
    expect(totals.cachedTokens).toBe(30);
  });

  it('counts distinct repositories and models, ignoring the unknown placeholder', () => {
    db.upsertSessions([
      row({ sessionId: 'a', repository: 'r1', model: 'm1' }),
      row({ sessionId: 'b', repository: 'r1', model: 'm2' }),
      row({ sessionId: 'c', repository: 'r2', model: 'm1' }),
      row({ sessionId: 'd', repository: 'unknown', model: 'unknown' }),
    ]);

    const { totals } = db.overview(30);
    expect(totals.repositories).toBe(2);
    expect(totals.models).toBe(2);
  });

  it('averages only sessions that recorded a duration', () => {
    // A zero duration means "not measured", not "instant"; counting it would
    // halve the reported average for no reason.
    db.upsertSessions([
      row({ sessionId: 'a', durationMs: 100_000 }),
      row({ sessionId: 'b', durationMs: 0 }),
    ]);
    expect(db.overview(30).totals.avgSessionMs).toBe(100_000);
  });

  it('reports zeroes rather than nulls on an empty index', () => {
    const { totals } = db.overview(30);
    expect(totals).toMatchObject({ sessions: 0, steps: 0, inputTokens: 0, avgSessionMs: 0 });
  });
});

describe('by source', () => {
  it('groups totals per source, busiest first', () => {
    db.upsertSessions([
      row({ sessionId: 'a', source: 'copilot', interactionCount: 3 }),
      row({ sessionId: 'b', source: 'claude', interactionCount: 4 }),
      row({ sessionId: 'c', source: 'claude', interactionCount: 5 }),
    ]);

    const { bySource } = db.overview(30);
    expect(bySource[0]).toMatchObject({ source: 'claude', sessions: 2, steps: 9 });
    expect(bySource[1]).toMatchObject({ source: 'copilot', sessions: 1, steps: 3 });
  });
});

describe('daily series', () => {
  it('buckets sessions by local day and source', () => {
    const today = Date.now();
    db.upsertSessions([
      row({ sessionId: 'a', endedAtMs: today }),
      row({ sessionId: 'b', endedAtMs: today, source: 'copilot' }),
      row({ sessionId: 'c', endedAtMs: today - 2 * DAY_MS }),
    ]);

    const { daily } = db.overview(30);
    const todayClaude = daily.find((d) => d.day === isoDay(today) && d.source === 'claude');
    const todayCopilot = daily.find((d) => d.day === isoDay(today) && d.source === 'copilot');
    expect(todayClaude?.sessions).toBe(1);
    expect(todayCopilot?.sessions).toBe(1);
    expect(daily.find((d) => d.day === isoDay(today - 2 * DAY_MS))?.sessions).toBe(1);
  });

  it('excludes sessions older than the window', () => {
    db.upsertSessions([
      row({ sessionId: 'recent', endedAtMs: Date.now() - DAY_MS }),
      row({ sessionId: 'ancient', endedAtMs: Date.now() - 90 * DAY_MS }),
    ]);

    const { daily } = db.overview(30);
    expect(daily.reduce((sum, d) => sum + d.sessions, 0)).toBe(1);
  });

  it('skips rows with no end timestamp, which would land in 1970', () => {
    db.upsertSessions([row({ sessionId: 'undated', endedAtMs: 0 })]);
    expect(db.overview(30).daily).toEqual([]);
  });

  it('returns days oldest first, so a chart can render them in order', () => {
    const now = Date.now();
    db.upsertSessions([
      row({ sessionId: 'newer', endedAtMs: now }),
      row({ sessionId: 'older', endedAtMs: now - 3 * DAY_MS }),
    ]);

    const days = db.overview(30).daily.map((d) => d.day);
    expect([...days].sort()).toEqual(days);
  });

  it('reports the window it covered, so the UI can label it', () => {
    expect(db.overview(14).windowDays).toBe(14);
  });
});

describe('top repositories', () => {
  it('ranks by session count and omits unknown', () => {
    db.upsertSessions([
      row({ sessionId: 'a', repository: 'r1' }),
      row({ sessionId: 'b', repository: 'r1' }),
      row({ sessionId: 'c', repository: 'r2' }),
      row({ sessionId: 'd', repository: 'unknown' }),
      row({ sessionId: 'e', repository: 'unknown' }),
    ]);

    const { topRepositories } = db.overview(30);
    expect(topRepositories).toEqual([
      { repository: 'r1', sessions: 2 },
      { repository: 'r2', sessions: 1 },
    ]);
  });

  it('caps the list, so a long tail does not fill the card', () => {
    db.upsertSessions(
      Array.from({ length: TOP_REPOSITORY_LIMIT + 4 }, (_, i) =>
        row({ sessionId: `s${i}`, repository: `repo-${i}` }),
      ),
    );
    expect(db.overview(30).topRepositories).toHaveLength(TOP_REPOSITORY_LIMIT);
  });

  it('breaks ties by name, so a repository cannot vanish between runs', () => {
    // Several repositories on the same count is the normal case; without a
    // second sort key SQLite picks arbitrarily and the list is unstable.
    db.upsertSessions([
      row({ sessionId: 'a', repository: 'zebra' }),
      row({ sessionId: 'b', repository: 'alpha' }),
      row({ sessionId: 'c', repository: 'mango' }),
    ]);
    expect(db.overview(30).topRepositories.map((r) => r.repository)).toEqual([
      'alpha',
      'mango',
      'zebra',
    ]);
  });
});

describe('fetching rows by key', () => {
  it('returns the named sessions, newest first', () => {
    db.upsertSessions([
      row({ sessionId: 'a', endedAtMs: 1_000 }),
      row({ sessionId: 'b', endedAtMs: 9_000 }),
      row({ sessionId: 'c', endedAtMs: 5_000 }),
    ]);

    const rows = db.getRowsByKey(['claude:a', 'claude:b']);
    expect(rows.map((r) => r.sessionId)).toEqual(['b', 'a']);
  });

  it('is empty for no keys, without running a query', () => {
    expect(db.getRowsByKey([])).toEqual([]);
  });

  it('ignores keys that are not in the index', () => {
    db.upsertSessions([row({ sessionId: 'a' })]);
    expect(db.getRowsByKey(['claude:a', 'claude:gone']).map((r) => r.sessionId)).toEqual(['a']);
  });
});
