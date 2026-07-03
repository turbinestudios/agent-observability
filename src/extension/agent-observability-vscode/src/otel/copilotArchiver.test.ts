import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'node-sqlite3-wasm';
import { CopilotArchiver } from './copilotArchiver';
import { IngestStore } from './ingestStore';
import { SpanRow } from './otlpToRows';
import { createReadonlySnapshot } from '../telemetry/snapshot';
import { PathConfig } from '../telemetry/paths';

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

/** Build a minimal `spans`-row for a session; end time is the watermark axis. */
function span(spanId: string, endMs: number, session: string, op = 'chat'): SpanRow {
  return {
    span_id: spanId,
    trace_id: 'tr',
    parent_span_id: null,
    name: op,
    start_time_ms: endMs - 100,
    end_time_ms: endMs,
    status_code: 1,
    status_message: null,
    operation_name: op,
    provider_name: null,
    agent_name: 'copilot',
    conversation_id: session,
    request_model: null,
    response_model: 'gpt-x',
    input_tokens: 10,
    output_tokens: 5,
    cached_tokens: 0,
    reasoning_tokens: null,
    tool_name: null,
    tool_call_id: null,
    tool_type: null,
    chat_session_id: session,
    turn_index: null,
    ttft_ms: null,
  };
}

/** Write a fake native Copilot DB (rollback-journal, like the real read path handles). */
function makeNativeDb(dir: string, name: string, spans: SpanRow[], mtimeMs: number): string {
  const p = path.join(dir, name);
  const store = new IngestStore(p);
  store.writeSpans({ spans, attributes: [] });
  store.close();
  const when = new Date(mtimeMs);
  utimesSync(p, when, when);
  return p;
}

/** Append spans to an existing native DB and stamp a distinct mtime. */
function appendNativeDb(p: string, spans: SpanRow[], mtimeMs: number): void {
  const store = new IngestStore(p);
  store.writeSpans({ spans, attributes: [] });
  store.close();
  const when = new Date(mtimeMs);
  utimesSync(p, when, when);
}

interface ArchiveSnapshot {
  spanCount: number;
  sessions: string[];
  watermarks: { source_path: string; last_end_ms: number; source_mtime_ms: number | null }[];
}

function readArchive(archivePath: string): ArchiveSnapshot {
  const db = new Database(archivePath, { readOnly: true, fileMustExist: true });
  try {
    const spanCount = (db.get('SELECT COUNT(*) AS n FROM spans') as { n: number }).n;
    const sessions = (
      db.all('SELECT session_id FROM sessions ORDER BY session_id') as { session_id: string }[]
    ).map((r) => r.session_id);
    const watermarks = db.all(
      'SELECT source_path, last_end_ms, source_mtime_ms FROM archive_watermark ORDER BY source_path',
    ) as ArchiveSnapshot['watermarks'];
    return { spanCount, sessions, watermarks };
  } finally {
    db.close();
  }
}

const cfg = (nativePath: string): PathConfig => ({ getSqlitePathOverride: () => nativePath });
const T = 1_700_000_000_000; // a realistic epoch-ms base well above the grace window

describe('CopilotArchiver.sweep', () => {
  it('copies native spans into the durable archive on the first sweep', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const native = makeNativeDb(tmp, 'native.db', [span('c0', T, 'S'), span('t0', T + 500, 'S')], 1_000_000);
    const archivePath = path.join(tmp, 'archive', 'agent-traces.db');

    const archiver = new CopilotArchiver({
      archiveDbPath: archivePath,
      config: cfg(native),
      retentionMs: 999 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60_000,
      signal: () => undefined,
      now: () => T + 1000,
    });
    archiver.start();
    archiver.stop();

    const arc = readArchive(archivePath);
    expect(arc.spanCount).toBe(2);
    expect(arc.sessions).toEqual(['S']);
    expect(arc.watermarks).toHaveLength(1);
    expect(arc.watermarks[0].source_path).toBe(native);
    // Watermark = max(end) - GRACE(5s).
    expect(arc.watermarks[0].last_end_ms).toBe(T + 500 - 5000);
    expect(arc.watermarks[0].source_mtime_ms).toBe(1_000_000);
  });

  it('sweeps incrementally: only spans past the watermark are re-read, no duplication', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const native = makeNativeDb(
      tmp,
      'native.db',
      [span('c0', T, 'S'), span('c1', T + 100_000, 'S'), span('c2', T + 200_000, 'S')],
      1_000_000,
    );
    const archivePath = path.join(tmp, 'archive', 'agent-traces.db');
    const archiver = new CopilotArchiver({
      archiveDbPath: archivePath,
      config: cfg(native),
      retentionMs: 999 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60_000,
      signal: () => undefined,
      now: () => T,
    });
    archiver.start(); // sweep #1 ingests all 3

    // Add one span far past the grace window, bump mtime, sweep again.
    appendNativeDb(native, [span('c3', T + 300_000, 'S')], 2_000_000);
    const wrote = archiver.sweepOnce();
    archiver.stop();

    // Watermark after #1 was (T+200_000 - 5000); only c2 (re-read) + c3 (new) exceed it.
    expect(wrote).toBe(2);
    const arc = readArchive(archivePath);
    expect(arc.spanCount).toBe(4); // no duplication despite the grace re-read
    expect(arc.watermarks[0].last_end_ms).toBe(T + 300_000 - 5000);
  });

  it('skips a source whose mtime is unchanged (opens no snapshot)', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const native = makeNativeDb(tmp, 'native.db', [span('c0', T, 'S')], 1_000_000);
    const archivePath = path.join(tmp, 'archive', 'agent-traces.db');
    let snapCalls = 0;
    const archiver = new CopilotArchiver({
      archiveDbPath: archivePath,
      config: cfg(native),
      retentionMs: 999 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60_000,
      signal: () => undefined,
      now: () => T,
      snapshotFactory: (p) => {
        snapCalls += 1;
        return createReadonlySnapshot(p);
      },
    });
    archiver.start(); // sweep #1 snapshots the source once
    expect(snapCalls).toBe(1);

    const wrote = archiver.sweepOnce(); // unchanged → skipped
    archiver.stop();
    expect(wrote).toBe(0);
    expect(snapCalls).toBe(1);
  });

  it('dedups a session present in two sources (native + live-ingest) by span_id', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const native = makeNativeDb(tmp, 'native.db', [span('c0', T, 'S'), span('c1', T + 100, 'S')], 1_000_000);
    const live = makeNativeDb(tmp, 'ingest.db', [span('c0', T, 'S'), span('c1', T + 100, 'S')], 1_500_000);
    const archivePath = path.join(tmp, 'archive', 'agent-traces.db');
    const archiver = new CopilotArchiver({
      archiveDbPath: archivePath,
      config: cfg(native),
      liveIngestDbPath: live,
      retentionMs: 999 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60_000,
      signal: () => undefined,
      now: () => T,
    });
    archiver.start();
    archiver.stop();

    const arc = readArchive(archivePath);
    expect(arc.spanCount).toBe(2); // same span_ids across sources → one row each
    expect(arc.sessions).toEqual(['S']);
    expect(arc.watermarks.map((w) => w.source_path).sort()).toEqual([live, native].sort());
  });

  it('prunes spans older than the retention window after sweeping', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const now = T;
    const retentionMs = 60 * 60 * 1000; // 1 hour
    const oldSpan = span('old', 2000, 'OLD'); // start_time_ms ~1900, far older than the window
    const recent = span('new', now, 'NEW'); // start_time_ms now-100, inside the window
    const native = makeNativeDb(tmp, 'native.db', [oldSpan, recent], 1_000_000);
    const archivePath = path.join(tmp, 'archive', 'agent-traces.db');
    const archiver = new CopilotArchiver({
      archiveDbPath: archivePath,
      config: cfg(native),
      retentionMs,
      sweepIntervalMs: 60_000,
      signal: () => undefined,
      now: () => now,
    });
    archiver.start();
    archiver.stop();

    const arc = readArchive(archivePath);
    expect(arc.spanCount).toBe(1); // the aged span was pruned in the same tick
    expect(arc.sessions).toEqual(['NEW']);
  });

  it('archives session titles from the native workspaceStorage stores', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const S1 = 'aaaaaaaa-1111-2222-3333-444444444444';
    // A REAL native layout: the DB inside globalStorage/github.copilot-chat with
    // a sibling workspaceStorage carrying the state.vscdb chat-session index.
    const globalDir = path.join(tmp, 'User', 'globalStorage', 'github.copilot-chat');
    mkdirSync(globalDir, { recursive: true });
    const native = makeNativeDb(globalDir, 'agent-traces.db', [span('c0', T, S1)], 1_000_000);
    const wsDir = path.join(tmp, 'User', 'workspaceStorage', 'hashA');
    mkdirSync(wsDir, { recursive: true });
    const stateDb = new Database(path.join(wsDir, 'state.vscdb'));
    stateDb.exec('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)');
    stateDb.run('INSERT INTO ItemTable (key, value) VALUES (?, ?)', [
      'chat.ChatSessionStore.index',
      JSON.stringify({
        version: 1,
        entries: {
          [S1]: { sessionId: S1, title: 'Fix the login flow', isEmpty: false },
          // Known upstream but NOT in the archive's spans → must not be stored.
          'bbbbbbbb-1111-2222-3333-444444444444': { title: 'Unrelated', isEmpty: false },
        },
      }),
    ]);
    stateDb.close();

    const archivePath = path.join(tmp, 'archive', 'agent-traces.db');
    const archiver = new CopilotArchiver({
      archiveDbPath: archivePath,
      config: cfg(native),
      retentionMs: 999 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60_000,
      signal: () => undefined,
      now: () => T,
    });
    archiver.start(); // sweeps spans, then titles
    // A second title sweep with nothing changed writes nothing (mtime stays cold).
    expect(archiver.sweepTitles()).toBe(0);
    archiver.stop();

    const db = new Database(archivePath, { readOnly: true, fileMustExist: true });
    try {
      const rows = db.all('SELECT chat_session_id, title, derived FROM session_titles') as {
        chat_session_id: string;
        title: string;
        derived: number;
      }[];
      expect(rows).toEqual([{ chat_session_id: S1, title: 'Fix the login flow', derived: 0 }]);
    } finally {
      db.close();
    }
  });

  it('sweeps no titles for a source outside the native copilot layout', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const native = makeNativeDb(tmp, 'native.db', [span('c0', T, 'S')], 1_000_000);
    const archivePath = path.join(tmp, 'archive', 'agent-traces.db');
    const archiver = new CopilotArchiver({
      archiveDbPath: archivePath,
      config: cfg(native),
      retentionMs: 999 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60_000,
      signal: () => undefined,
      now: () => T,
    });
    archiver.start();
    expect(archiver.sweepTitles()).toBe(0); // no workspaceStorage beside a bare fixture
    archiver.stop();
  });

  it('fires signal only when a sweep writes new rows', () => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'arch-'));
    const native = makeNativeDb(tmp, 'native.db', [span('c0', T, 'S')], 1_000_000);
    const archivePath = path.join(tmp, 'archive', 'agent-traces.db');
    let signals = 0;
    const archiver = new CopilotArchiver({
      archiveDbPath: archivePath,
      config: cfg(native),
      retentionMs: 999 * 24 * 60 * 60 * 1000,
      sweepIntervalMs: 60_000,
      signal: () => {
        signals += 1;
      },
      now: () => T,
    });
    archiver.start(); // wrote rows → one signal
    expect(signals).toBe(1);
    archiver.sweepOnce(); // unchanged → no write → no signal
    archiver.stop();
    expect(signals).toBe(1);
  });
});
