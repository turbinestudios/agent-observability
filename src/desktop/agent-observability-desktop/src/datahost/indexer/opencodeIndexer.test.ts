import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { describeDeletion } from '../deletion';
import { IndexDb } from './indexDb';
import { OpencodeIndexer } from './opencodeIndexer';

// node:sqlite is loaded through a real require (see telemetry/snapshot.test.ts):
// it is the only driver here that can write a genuine WAL-mode file.
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
};

/**
 * OpenCode sessions end to end against a temp `opencode.db` and a temp index.
 * Nothing here reads the real `~/.local/share/opencode`.
 */
const T0 = 1_790_000_000_000;
let root: string;
let dbPath: string;
let db: IndexDb;

function writeStore(sessions: string[]): void {
  const store = new DatabaseSync(dbPath);
  store.exec('PRAGMA journal_mode = WAL;');
  store.exec(`
    CREATE TABLE IF NOT EXISTS project (id text PRIMARY KEY, worktree text NOT NULL);
    CREATE TABLE IF NOT EXISTS session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, directory text NOT NULL,
      title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
    CREATE TABLE IF NOT EXISTS message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);
    CREATE TABLE IF NOT EXISTS part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);
    INSERT OR IGNORE INTO project VALUES ('prj', '${path.join(root, 'repo').replace(/'/g, "''")}');
  `);
  for (const [i, id] of sessions.entries()) {
    const at = T0 + i * 60_000;
    store.prepare('INSERT OR IGNORE INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, 'prj', null, path.join(root, 'repo'), `Session ${id}`, '2.1.2', at, at);
    store.prepare('INSERT OR IGNORE INTO message VALUES (?, ?, ?, ?)').run(`${id}-u`, id, at, JSON.stringify({ role: 'user', agent: 'build', time: { created: at } }));
    store
      .prepare('INSERT OR IGNORE INTO message VALUES (?, ?, ?, ?)')
      .run(
        `${id}-a`,
        id,
        at + 1_000,
        JSON.stringify({
          role: 'assistant',
          providerID: 'github-copilot',
          modelID: 'gpt-5',
          parentID: `${id}-u`,
          time: { created: at + 1_000, completed: at + 3_000 },
          tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 50, write: 0 } },
          cost: 0,
        }),
      );
  }
  store.close();
}

function config(overrides: Record<string, unknown> = {}): Configuration {
  const values: Record<string, unknown> = { 'opencode.dbPath': dbPath, ...overrides };
  return new Configuration({
    get: <T,>(key: string, fallback: T): T => (values[key] === undefined ? fallback : (values[key] as T)),
    onDidChange: () => ({ dispose: () => undefined }),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-opencode-index-'));
  dbPath = path.join(root, 'opencode.db');
  db = new IndexDb(path.join(root, 'index.db'));
});

afterEach(() => {
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('OpenCode indexing', { timeout: 30_000 }, () => {
  it('files every session under the opencode source with its provider-qualified model', () => {
    writeStore(['ses_a', 'ses_b']);
    const result = new OpencodeIndexer({ db, config: config() }).run();
    expect(result).toMatchObject({ discovered: 2, hydrated: 2 });
    expect(db.getRow('opencode', 'ses_a')).toMatchObject({
      title: 'Session ses_a',
      model: 'github-copilot/gpt-5',
      inputTokens: 100,
      cachedTokens: 50,
    });
    // A Copilot-served session is unpriced, never $0.
    expect(db.getRow('opencode', 'ses_a')?.costMicros).toBeUndefined();
  });

  it('skips an unchanged database and picks up a new session once it moves', () => {
    writeStore(['ses_a']);
    new OpencodeIndexer({ db, config: config() }).run();
    expect(new OpencodeIndexer({ db, config: config() }).run()).toMatchObject({ discovered: 1, hydrated: 0 });
    writeStore(['ses_a', 'ses_b']);
    expect(new OpencodeIndexer({ db, config: config() }).run()).toMatchObject({ discovered: 2, hydrated: 2 });
    expect(db.getRow('opencode', 'ses_b')).toBeDefined();
  });

  it('removes its rows when the database is gone, and indexes nothing while off', () => {
    writeStore(['ses_a']);
    new OpencodeIndexer({ db, config: config() }).run();
    expect(new OpencodeIndexer({ db, config: config({ 'opencode.enabled': false }) }).run()).toEqual({ discovered: 0, hydrated: 0 });
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    new OpencodeIndexer({ db, config: config() }).run();
    expect(db.getRow('opencode', 'ses_a')).toBeUndefined();
  });

  it('never offers to delete from OpenCode', () => {
    expect(describeDeletion('opencode', 'ses_a', { config: config() } as never)).toMatchObject({ supported: false, target: 'Stored by OpenCode' });
  });
});
