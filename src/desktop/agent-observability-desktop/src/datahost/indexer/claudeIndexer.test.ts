import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import type { SettingsReader } from '@agent-observability/core/src/config/configuration';
import { defaultFs } from '@agent-observability/core/src/claude/paths';
import type { ClaudeFs } from '@agent-observability/core/src/claude/paths';
import { ClaudeIndexer } from './claudeIndexer';
import { IndexDb } from './indexDb';
import type { SessionRow } from '../../shared/rpc';

/**
 * The indexer against real transcript files on disk.
 *
 * The behavior worth pinning is incremental: a second pass over unchanged files
 * must parse nothing, an appended file must be re-read, and a session deleted
 * from disk must leave the list. Those are what make the app fast on every
 * launch after the first, and a regression in them is invisible until someone
 * notices startup crawling.
 */

let root: string;
let projects: string;
let dbPath: string;
let db: IndexDb;

/** Settings backed by a plain object — no file, no host. */
function settings(values: Record<string, unknown>): SettingsReader {
  return {
    get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue,
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

function makeConfig(enabled = true): Configuration {
  return new Configuration(
    settings({ 'claudeCode.projectsPath': projects, 'claudeCode.enabled': enabled }),
  );
}

/**
 * Confines discovery to the fixture. A configured projects path is additive in
 * core — the real home directory is scanned too — so without redirecting
 * `homedir` these tests would index the developer's own transcripts.
 */
function isolatedFs(): ClaudeFs {
  return { ...defaultFs, homedir: () => root, env: {} };
}

/**
 * Write a minimal but realistic transcript the core parser accepts. The working
 * directory points inside the fixture so git-remote resolution finds no
 * checkout, rather than walking up into the real repository.
 */
function writeTranscript(sessionId: string, turns: number, cwd = path.join(root, 'work', 'app')): string {
  const dir = path.join(projects, '-work-app');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const lines: string[] = [];
  for (let i = 0; i < turns; i += 1) {
    lines.push(
      JSON.stringify({
        type: 'user',
        cwd,
        sessionId,
        timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
        message: { role: 'user', content: [{ type: 'text', text: `question ${i}` }] },
      }),
    );
    lines.push(
      JSON.stringify({
        type: 'assistant',
        cwd,
        sessionId,
        timestamp: new Date(1_700_000_000_000 + i * 60_000 + 30_000).toISOString(),
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4',
          content: [{ type: 'text', text: `answer ${i}` }],
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 },
        },
      }),
    );
  }
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

function appendTurn(file: string, sessionId: string): void {
  const line = JSON.stringify({
    type: 'assistant',
    cwd: path.join(root, 'work', 'app'),
    sessionId,
    timestamp: new Date(1_800_000_000_000).toISOString(),
    message: {
      role: 'assistant',
      model: 'claude-sonnet-4',
      content: [{ type: 'text', text: 'appended' }],
      usage: { input_tokens: 5, output_tokens: 5 },
    },
  });
  fs.appendFileSync(file, line + '\n', 'utf8');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-indexer-'));
  projects = path.join(root, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  dbPath = path.join(root, 'index.db');
  db = new IndexDb(dbPath);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function runIndexer(onRows?: (rows: SessionRow[]) => void) {
  return new ClaudeIndexer({ db, config: makeConfig(), fs: isolatedFs(), onRows }).run();
}

describe('first pass', () => {
  it('indexes discovered sessions with parsed counts', () => {
    writeTranscript('sess-a', 3);
    const result = runIndexer();

    expect(result.discovered).toBe(1);
    expect(result.hydrated).toBe(1);

    const [row] = db.listSessions({});
    expect(row.sessionId).toBe('sess-a');
    expect(row.pending).toBeUndefined();
    expect(row.inputTokens).toBe(300);
    expect(row.outputTokens).toBe(150);
    expect(row.model).toBe('claude-sonnet-4');
  });

  it('emits placeholder rows before parsed ones, so the list can paint early', () => {
    writeTranscript('sess-a', 2);
    const batches: SessionRow[][] = [];
    runIndexer((rows) => batches.push(rows));

    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0][0].pending).toBe(true);
    expect(batches[batches.length - 1][0].pending).toBe(false);
  });

  it('reports every discovered session, with no cap', () => {
    for (let i = 0; i < 40; i += 1) {
      writeTranscript(`sess-${String(i).padStart(2, '0')}`, 1);
    }
    expect(runIndexer().discovered).toBe(40);
    expect(db.counts().indexed).toBe(40);
  });
});

describe('incremental passes', () => {
  it('retries an interrupted hydration without advancing the file fingerprint', () => {
    const file = writeTranscript('sess-a', 2);
    runIndexer();
    const before = db.getRow('claude', 'sess-a');
    const fingerprint = db.getFileState(file);
    appendTurn(file, 'sess-a');
    const write = vi.spyOn(db, 'upsertHydratedSessions').mockImplementationOnce(() => {
      throw new Error('Interrupted before batch commit');
    });
    expect(() => runIndexer()).toThrow('Interrupted');
    expect(db.getRow('claude', 'sess-a')).toEqual(before);
    expect(db.getFileState(file)).toEqual(fingerprint);
    write.mockRestore();
    expect(runIndexer().hydrated).toBe(1);
    expect(db.getRow('claude', 'sess-a')!.interactionCount).toBeGreaterThan(before!.interactionCount);
  });

  it('rolls back both summary and fingerprint when the fingerprint write fails', () => {
    const file = writeTranscript('sess-a', 2);
    runIndexer();
    const before = db.getRow('claude', 'sess-a');
    const fingerprint = db.getFileState(file);
    appendTurn(file, 'sess-a');
    const write = vi.spyOn(db, 'putFileState').mockImplementationOnce(() => {
      throw new Error('Interrupted inside batch transaction');
    });
    expect(() => runIndexer()).toThrow('Interrupted');
    expect(db.getRow('claude', 'sess-a')).toEqual(before);
    expect(db.getFileState(file)).toEqual(fingerprint);
    write.mockRestore();
    expect(runIndexer().hydrated).toBe(1);
  });

  it('parses nothing when no file changed', () => {
    writeTranscript('sess-a', 3);
    runIndexer();

    const second = runIndexer();
    expect(second.discovered).toBe(1);
    expect(second.hydrated).toBe(0);
  });

  it('re-reads a transcript that grew', () => {
    const file = writeTranscript('sess-a', 2);
    runIndexer();
    const before = db.listSessions({})[0].interactionCount;

    appendTurn(file, 'sess-a');
    // mtime resolution can be coarse enough that an immediate append looks
    // unchanged; the size difference is what must trigger the re-read.
    const second = runIndexer();

    expect(second.hydrated).toBe(1);
    expect(db.listSessions({})[0].interactionCount).toBeGreaterThan(before);
  });

  it('drops a session whose transcript was deleted', () => {
    const file = writeTranscript('sess-a', 1);
    writeTranscript('sess-b', 1);
    runIndexer();
    expect(db.listSessions({})).toHaveLength(2);

    fs.rmSync(file);
    runIndexer();

    expect(db.listSessions({}).map((r) => r.sessionId)).toEqual(['sess-b']);
  });
});

describe('cost', () => {
  // The fixture's every assistant turn is claude-sonnet-4 with usage
  // {input 100, output 50, cache read 10}: 100×$3/M + 50×$15/M + 10×$3/M×0.1
  // = 1,053 micro-USD per turn — the same token×rate pricing the detail view
  // uses, so the row and the detail agree.
  const MICROS_PER_TURN = 1_053;

  it('prices a hydrated session from its parsed turns', () => {
    writeTranscript('sess-a', 3);
    runIndexer();

    expect(db.listSessions({})[0].costMicros).toBe(3 * MICROS_PER_TURN);
  });

  it('stores NULL for a session no known model can price — n/a, not free', () => {
    const dir = path.join(projects, '-work-app');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      type: 'assistant',
      cwd: path.join(root, 'work', 'app'),
      sessionId: 'sess-unknown',
      timestamp: new Date(1_700_000_000_000).toISOString(),
      message: {
        role: 'assistant',
        model: 'totally-unknown-model',
        content: [{ type: 'text', text: 'answer' }],
        usage: { input_tokens: 100, output_tokens: 50 },
      },
    });
    fs.writeFileSync(path.join(dir, 'sess-unknown.jsonl'), line + '\n', 'utf8');

    runIndexer();

    expect(db.listSessions({})[0].costMicros).toBeUndefined();
  });

  it('re-prices the whole session when the transcript grows', () => {
    const file = writeTranscript('sess-a', 2);
    runIndexer();
    expect(db.listSessions({})[0].costMicros).toBe(2 * MICROS_PER_TURN);

    // The appended turn uses {input 5, output 5}: 5×$3/M + 5×$15/M = 90 micro-USD.
    appendTurn(file, 'sess-a');
    runIndexer();

    expect(db.listSessions({})[0].costMicros).toBe(2 * MICROS_PER_TURN + 90);
  });
});

describe('resilience', () => {
  it('skips a corrupt transcript without failing the pass', () => {
    writeTranscript('good', 2);
    const dir = path.join(projects, '-work-app');
    const corrupt = '{not json at all\n{"truncated": \n';
    fs.writeFileSync(path.join(dir, 'broken.jsonl'), corrupt, 'utf8');

    expect(() => runIndexer()).not.toThrow();
    expect(db.listSessions({}).some((r) => r.sessionId === 'good')).toBe(true);
  });

  it('does nothing when the Claude source is disabled', () => {
    writeTranscript('sess-a', 1);
    const result = new ClaudeIndexer({ db, config: makeConfig(false), fs: isolatedFs() }).run();

    expect(result).toEqual({ discovered: 0, hydrated: 0 });
    expect(db.listSessions({})).toEqual([]);
  });

  it('records the repository resolved for a session', () => {
    writeTranscript('sess-a', 1);
    runIndexer();
    // No git remote in a temp dir, so it must fall back rather than fail.
    expect(db.listSessions({})[0].repository).toBe('unknown');
  });
});
