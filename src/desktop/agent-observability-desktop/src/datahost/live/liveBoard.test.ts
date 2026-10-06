import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import type { ClaudeFs } from '@agent-observability/core/src/claude/paths';
import type { TranscriptRecord } from '@agent-observability/core/src/claude/transcript';
import type { FileWatchFactory } from '@agent-observability/core/src/live/claudeWatcher';
import type { RpcEvent, SessionRow } from '../../shared/rpc';
import { IndexDb } from '../indexer/indexDb';
import {
  LIVE_DEBOUNCE_MS,
  LIVE_DROP_MS,
  LIVE_REINDEX_QUIET_MS,
  LIVE_TICK_MS,
  LiveBoardService,
} from './liveBoard';

/**
 * The live board against fakes for everything that touches the machine: the
 * watch factory records handlers so a test fires events, the stat and tail
 * seams return fixtures, timers are vitest's, and the index is a temp file.
 */

const PROJECTS = path.join(path.sep, 'claude', 'projects');
const PROJECT = path.join(PROJECTS, 'C--repo');
const MAIN = path.join(PROJECT, 'abc.jsonl');
const OTHER = path.join(PROJECT, 'def.jsonl');

let dbPath: string;
let db: IndexDb;
let now: number;
let events: RpcEvent[];
let indexRequests: number;
let watches: { target: string; onEvent: (p: string) => void; disposed: boolean }[];
let stats: Map<string, number>;
let tails: Map<string, TranscriptRecord[]>;

function config(overrides: Record<string, unknown> = {}): Configuration {
  // Copilot CLI is off here so no test reads this machine's real ~/.copilot; its provider has its own test file.
  const values: Record<string, unknown> = { 'claudeCode.projectsPath': PROJECTS, 'copilotCli.enabled': false, ...overrides };
  return new Configuration({
    get: <T,>(key: string, fallback: T): T => (values[key] === undefined ? fallback : (values[key] as T)),
    onDidChange: () => ({ dispose: () => undefined }),
  });
}

const claudeFs: ClaudeFs = {
  homedir: () => '',
  env: {},
  isDirectory: (p) => path.normalize(p) === path.normalize(PROJECTS) || path.normalize(p) === path.normalize(PROJECT),
  readDir: (p) => {
    if (path.normalize(p) === path.normalize(PROJECTS)) {
      return [{ name: 'C--repo', isDirectory: true, isFile: false }];
    }
    if (path.normalize(p) === path.normalize(PROJECT)) {
      return [...stats.keys()]
        .filter((file) => path.dirname(file) === PROJECT)
        .map((file) => ({ name: path.basename(file), isDirectory: false, isFile: true }));
    }
    return [];
  },
  mtimeMs: (p) => stats.get(path.normalize(p)),
};

const factory: FileWatchFactory = {
  watch: (target, onEvent) => {
    const entry = { target, onEvent, disposed: false };
    watches.push(entry);
    return { dispose: () => void (entry.disposed = true) };
  },
};

function record(over: Partial<TranscriptRecord>): TranscriptRecord {
  return { type: 'user', timestamp: new Date(now - 1_000).toISOString(), ...over };
}

function userPrompt(): TranscriptRecord[] {
  return [record({ type: 'user', message: { role: 'user', content: 'do the thing' } })];
}

function assistantText(): TranscriptRecord[] {
  return [record({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } })];
}

function indexRow(over: Partial<SessionRow> & Pick<SessionRow, 'sessionId'>): SessionRow {
  return {
    source: 'claude',
    repository: 'https://github.com/o/repo',
    title: 'Indexed title',
    startedAtMs: now - 60_000,
    endedAtMs: now - 1_000,
    durationMs: 59_000,
    interactionCount: 3,
    llmCalls: 2,
    toolCalls: 1,
    inputTokens: 1_000,
    outputTokens: 200,
    cachedTokens: 0,
    model: 'claude-opus',
    agentModes: ['agent'],
    indexedAtMs: now - 500,
    costMicros: 12_000,
    ...over,
  };
}

function service(overrides: Record<string, unknown> = {}): LiveBoardService {
  return new LiveBoardService({
    db,
    config: config(overrides),
    hidden: { all: () => [], isHidden: () => false },
    renames: { apply: (rows) => rows },
    emit: (event) => events.push(event),
    requestIndex: () => void (indexRequests += 1),
    claudeFs,
    readTail: (file) => {
      const records = tails.get(path.normalize(file));
      const mtime = stats.get(path.normalize(file));
      return records === undefined || mtime === undefined
        ? undefined
        : { records, skipped: 0, sizeBytes: 1, mtimeMs: mtime, truncated: false };
    },
    statFile: (file) => {
      const mtime = stats.get(path.normalize(file));
      return mtime === undefined ? undefined : { size: 1, mtimeMs: mtime };
    },
    now: () => now,
    factories: { transcripts: factory, databases: factory },
    copilotDatabases: () => [],
  });
}

function liveEvents(): Extract<RpcEvent, { event: 'workspace.live' }>[] {
  return events.filter((e): e is Extract<RpcEvent, { event: 'workspace.live' }> => e.event === 'workspace.live');
}

beforeEach(() => {
  vi.useFakeTimers();
  now = 1_700_000_000_000;
  events = [];
  indexRequests = 0;
  watches = [];
  stats = new Map([[path.normalize(MAIN), now - 1_000]]);
  tails = new Map([[path.normalize(MAIN), userPrompt()]]);
  dbPath = path.join(os.tmpdir(), `ao-live-${process.pid}-${Math.random().toString(36).slice(2)}.db`);
  db = new IndexDb(dbPath);
  db.upsertSessions([indexRow({ sessionId: 'abc' })]);
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
});

describe('LiveBoardService', () => {
  it('seeds the board from discovery and joins the index row for title, tokens and cost', () => {
    const live = service({ 'localTelemetry.enabled': false });
    live.start();
    const snapshot = live.snapshot();
    expect(snapshot.watching).toBe(true);
    expect(snapshot.rows).toHaveLength(1);
    const [row] = snapshot.rows;
    expect(row).toMatchObject({
      source: 'claude',
      sessionId: 'abc',
      title: 'Indexed title',
      repository: 'https://github.com/o/repo',
      status: 'working',
      lastEvent: 'user-prompt',
      inputTokens: 1_000,
      outputTokens: 200,
      costMicros: 12_000,
    });
    expect(liveEvents()).toHaveLength(1);
    live.stop();
  });

  it('flips to waiting when the transcript ends on an assistant answer, after the debounce', () => {
    const live = service({ 'localTelemetry.enabled': false });
    live.start();
    tails.set(path.normalize(MAIN), assistantText());
    stats.set(path.normalize(MAIN), now);
    watches.find((w) => w.target === path.normalize(PROJECTS))?.onEvent(MAIN);
    expect(liveEvents()).toHaveLength(1);
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS + 1);
    expect(liveEvents()).toHaveLength(2);
    expect(liveEvents()[1].snapshot.rows[0].status).toBe('waiting');
    live.stop();
  });

  it('adds a transcript it has never seen when the watcher reports it, and ignores sub-agent files', () => {
    const live = service({ 'localTelemetry.enabled': false });
    live.start();
    stats.set(path.normalize(OTHER), now);
    tails.set(path.normalize(OTHER), userPrompt());
    const watch = watches.find((w) => w.target === path.normalize(PROJECTS));
    watch?.onEvent(path.join(PROJECT, 'abc', 'subagents', 'agent-1.jsonl'));
    watch?.onEvent(OTHER);
    vi.advanceTimersByTime(LIVE_DEBOUNCE_MS + 1);
    const rows = live.snapshot().rows.map((r) => r.sessionId).sort();
    expect(rows).toEqual(['abc', 'def']);
    live.stop();
  });

  it('asks for one index pass once the transcript has been quiet, however many events arrived', () => {
    const live = service({ 'localTelemetry.enabled': false });
    live.start();
    const watch = watches.find((w) => w.target === path.normalize(PROJECTS));
    for (let i = 0; i < 5; i += 1) {
      watch?.onEvent(MAIN);
      vi.advanceTimersByTime(1_000);
    }
    expect(indexRequests).toBe(0);
    vi.advanceTimersByTime(LIVE_REINDEX_QUIET_MS);
    expect(indexRequests).toBe(1);
    live.stop();
  });

  it('turns idle, then finished, then leaves the board as time passes with no writes', () => {
    const live = service({ 'localTelemetry.enabled': false });
    live.start();
    now += 4 * 60_000;
    vi.advanceTimersByTime(LIVE_TICK_MS);
    expect(live.snapshot().rows[0].status).toBe('idle');
    now += 30 * 60_000;
    vi.advanceTimersByTime(LIVE_TICK_MS);
    expect(live.snapshot().rows[0].status).toBe('finished');
    now += LIVE_DROP_MS;
    vi.advanceTimersByTime(LIVE_TICK_MS);
    expect(live.snapshot().rows).toHaveLength(0);
    live.stop();
  });

  it('does not emit when nothing changed between ticks', () => {
    const live = service({ 'localTelemetry.enabled': false });
    live.start();
    const before = liveEvents().length;
    vi.advanceTimersByTime(LIVE_TICK_MS * 3);
    expect(liveEvents().length).toBe(before);
    live.stop();
  });

  it('leaves hidden sessions off the board', () => {
    const live = new LiveBoardService({
      db,
      config: config({ 'localTelemetry.enabled': false }),
      hidden: { all: () => ['claude:abc'], isHidden: (_s, id) => id === 'abc' },
      renames: { apply: (rows) => rows },
      emit: (event) => events.push(event),
      requestIndex: () => undefined,
      claudeFs,
      readTail: () => undefined,
      statFile: (file) => (stats.has(path.normalize(file)) ? { size: 1, mtimeMs: now } : undefined),
      now: () => now,
      factories: { transcripts: factory, databases: factory },
      copilotDatabases: () => [],
    });
    live.start();
    expect(live.snapshot().rows).toHaveLength(0);
    live.stop();
  });

  it('derives Copilot rows from the index by age alone', () => {
    db.upsertSessions([
      indexRow({ source: 'copilot', sessionId: 'c-working', endedAtMs: now - 10_000 }),
      indexRow({ source: 'copilot', sessionId: 'c-idle', endedAtMs: now - 5 * 60_000 }),
      indexRow({ source: 'copilot', sessionId: 'c-gone', endedAtMs: now - LIVE_DROP_MS - 1 }),
    ]);
    const live = service({ 'claudeCode.enabled': false });
    live.start();
    const byId = new Map(live.snapshot().rows.map((r) => [r.sessionId, r.status]));
    expect(byId.get('c-working')).toBe('working');
    expect(byId.get('c-idle')).toBe('idle');
    expect(byId.has('c-gone')).toBe(false);
    expect(live.snapshot().note).toContain('turned off');
    live.stop();
  });

  it('disposes its watches on stop and arms new ones on restart', () => {
    const live = service({ 'localTelemetry.enabled': false });
    live.start();
    expect(watches.filter((w) => !w.disposed)).toHaveLength(1);
    live.restart();
    expect(watches.filter((w) => w.disposed)).toHaveLength(1);
    expect(watches.filter((w) => !w.disposed)).toHaveLength(1);
    live.stop();
    expect(watches.every((w) => w.disposed)).toBe(true);
  });
});
