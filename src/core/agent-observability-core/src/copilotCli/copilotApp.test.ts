import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { CopilotCliSource } from './copilotCliSource';
import { cliClientOf, type CliEvent } from './events';
import { buildCliSessionDetail, resolveCliRepository, resolveCliUsage } from './mapper';
import { defaultCopilotCliFs, type CopilotCliFs } from './paths';
import { readSessionStoreUsage, type StoreModelUsage } from './sessionStoreUsage';

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
 * The GitHub Copilot app as its own source. Shapes are those app 1.1.24
 * wrote in October 2026: `client_name: github/autopilot`, the chat run in a
 * scratch folder under `~/.copilot/chats`, the project only as an attached
 * directory, no `session.shutdown`, and usage only in the runtime's
 * `session-store.db`. Nothing here reads the real `~/.copilot`.
 */
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
const ev = (type: string, data: Record<string, unknown>, offsetMs: number): CliEvent => ({
  type,
  data,
  timestamp: new Date(T0 + offsetMs).toISOString(),
});
const line = (type: string, data: Record<string, unknown>, offsetMs: number): string => JSON.stringify(ev(type, data, offsetMs));

let home: string;
let env: CopilotCliFs;

const config = (app = true, cli = true) => ({
  isCopilotCliEnabled: () => cli,
  isCopilotAppEnabled: () => app,
  getExcludedRepositories: () => new Set<string>(),
});

function writeSession(id: string, lines: string[], workspace: string): void {
  const dir = path.join(home, '.copilot', 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), workspace);
  fs.writeFileSync(path.join(dir, 'events.jsonl'), lines.join('\n') + '\n');
}

/** A checkout whose `.git/config` names a remote. */
function makeRepo(name: string, remote: string): string {
  const dir = path.join(home, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'config'), `[remote "origin"]\n\turl = ${remote}\n`);
  return dir;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-copilot-app-'));
  env = { ...defaultCopilotCliFs, homedir: () => home, env: {} };
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('telling the app apart from the CLI', () => {
  it('reads the client from workspace.yaml and nothing else', () => {
    expect(cliClientOf({ client_name: 'github/autopilot' })).toBe('app');
    expect(cliClientOf({ client_name: 'github/cli' })).toBe('cli');
    expect(cliClientOf({ client_name: 'sdk' })).toBe('cli');
    expect(cliClientOf({})).toBe('cli');
  });

  it('lists each session under exactly one source', () => {
    writeSession('app-1', [line('user.message', { content: 'Plan it' }, 0)], 'client_name: github/autopilot\nname: Plan');
    writeSession('cli-1', [line('user.message', { content: 'Fix it' }, 0)], 'client_name: github/cli\nname: Fix');
    const app = new CopilotCliSource(config(), env, 'app');
    const cli = new CopilotCliSource(config(), env);
    expect(app.id).toBe('copilot-app');
    expect(app.label).toBe('Copilot app');
    const appIds = app.listSessions();
    const cliIds = cli.listSessions();
    expect(appIds.ok && appIds.value.map((s) => [s.sessionId, s.source])).toEqual([['app-1', 'copilot-app']]);
    expect(cliIds.ok && cliIds.value.map((s) => [s.sessionId, s.source])).toEqual([['cli-1', 'copilot-cli']]);
  });

  it('switches off on its own flag', () => {
    writeSession('app-1', [line('user.message', { content: 'x' }, 0)], 'client_name: github/autopilot');
    const result = new CopilotCliSource(config(false, true), env, 'app').listSessions();
    expect(result.ok).toBe(false);
    expect(result.ok ? '' : result.message).toContain('Copilot app');
  });
});

describe('the repository of an app session', () => {
  it('comes from the attached directory when the scratch folder is no checkout', () => {
    const repo = makeRepo('project', 'https://github.com/o/attached.git');
    const scratch = path.join(home, '.copilot', 'chats', '2026-09-30', 'chat-1');
    fs.mkdirSync(scratch, { recursive: true });
    const events = [
      ev('session.start', { context: { cwd: scratch } }, 0),
      ev('user.message', { content: 'Look', attachments: [{ type: 'file', path: path.join(repo, 'a.ts') }, { type: 'directory', path: repo }] }, 1),
    ];
    const resolved = resolveCliRepository({ cwd: scratch }, events, (dir) =>
      fs.existsSync(path.join(dir, '.git')) ? 'https://github.com/o/attached' : 'unknown',
    );
    expect(resolved).toBe('https://github.com/o/attached');
  });

  it('stays unknown when the attached folder is gone', () => {
    const events = [ev('user.message', { content: 'Look', attachments: [{ type: 'directory', path: path.join(home, 'gone') }] }, 1)];
    expect(resolveCliRepository({ cwd: home }, events, () => 'unknown')).toBe('unknown');
  });

  it('prefers the cwd when it is a checkout', () => {
    const events = [ev('user.message', { content: 'Look', attachments: [{ type: 'directory', path: '/elsewhere' }] }, 1)];
    expect(resolveCliRepository({ cwd: '/repo' }, events, (dir) => (dir === '/repo' ? 'https://github.com/o/cwd' : 'https://github.com/o/other'))).toBe(
      'https://github.com/o/cwd',
    );
  });
});

describe('usage from the runtime store', () => {
  const store = new Map<string, StoreModelUsage>([
    ['claude-opus-5.5', { llmCalls: 13, inputTokens: 1_000, outputTokens: 50, cachedTokens: 800, reasoningTokens: 3, aiuNano: 9_000_000_000 }],
  ]);

  it('fills in tokens when the events carry no totals, keeping the events’ billed figure', () => {
    const events = [ev('assistant.message', { model: 'claude-opus-5.5' }, 0), ev('session.usage_checkpoint', { totalNanoAiu: 5_000_000_000 }, 1)];
    const usage = resolveCliUsage(events, store);
    expect(usage).toMatchObject({ inputTokens: 1_000, outputTokens: 50, cachedTokens: 800, reasoningTokens: 3, aiuNano: 5_000_000_000 });
    expect(usage.byModel.get('claude-opus-5.5')?.llmCalls).toBe(13);
  });

  it('uses the store’s billed figure only when the events have none', () => {
    expect(resolveCliUsage([ev('assistant.message', {}, 0)], store).aiuNano).toBe(9_000_000_000);
  });

  it('never overrides a session whose shutdown reported totals', () => {
    const events = [
      ev('session.shutdown', { modelMetrics: { 'gpt-5': { requests: { count: 1 }, usage: { inputTokens: 10, outputTokens: 2 } } } }, 0),
    ];
    expect(resolveCliUsage(events, store).inputTokens).toBe(10);
  });

  it('reads per-session, per-model sums from a live WAL-mode store without touching it', () => {
    const dbPath = path.join(home, 'session-store.db');
    const writer = new DatabaseSync(dbPath);
    writer.exec('PRAGMA journal_mode=WAL');
    writer.exec('PRAGMA wal_autocheckpoint=0');
    writer.exec(`CREATE TABLE assistant_usage_events (
      id INTEGER PRIMARY KEY, session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER,
      cache_read_tokens INTEGER, cache_write_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER,
      user_message TEXT)`);
    const insert = writer.prepare(
      'INSERT INTO assistant_usage_events (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reasoning_tokens, total_nano_aiu, user_message) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('s1', 'gpt-5', 100, 10, 60, 40, 1, 1000, 'never read');
    insert.run('s1', 'gpt-5', 200, 20, 150, 50, 0, 2000, 'never read');
    insert.run('s2', 'claude-sonnet-5', 7, 1, 0, 7, 0, 5, 'never read');
    const before = fs.statSync(dbPath).mtimeMs;
    try {
      const usage = readSessionStoreUsage(dbPath, { root: path.join(home, 'snapshots') });
      expect(usage.get('s1')?.get('gpt-5')).toEqual({
        llmCalls: 2,
        inputTokens: 300,
        outputTokens: 30,
        cachedTokens: 210,
        reasoningTokens: 1,
        aiuNano: 3000,
      });
      expect(usage.get('s2')?.get('claude-sonnet-5')?.inputTokens).toBe(7);
      expect(JSON.stringify([...usage.values()].map((m) => [...m.values()]))).not.toContain('never read');
      expect(fs.statSync(dbPath).mtimeMs).toBe(before);
    } finally {
      writer.close();
    }
  });

  it('reads an absent or foreign store as empty', () => {
    expect(readSessionStoreUsage(path.join(home, 'missing.db')).size).toBe(0);
    const other = path.join(home, 'other.db');
    const writer = new DatabaseSync(other);
    writer.exec('CREATE TABLE t (x INTEGER)');
    writer.close();
    expect(readSessionStoreUsage(other, { root: path.join(home, 'snapshots') }).size).toBe(0);
  });

  it('an app session lists with the store’s tokens and its own source', () => {
    writeSession(
      'app-1',
      [line('user.message', { content: 'Plan it' }, 0), line('assistant.message', { model: 'gpt-5' }, 1000), line('session.usage_checkpoint', { totalNanoAiu: 1_000_000_000 }, 2000)],
      'client_name: github/autopilot\nname: Plan',
    );
    const dbPath = path.join(home, '.copilot', 'session-store.db');
    const writer = new DatabaseSync(dbPath);
    writer.exec(
      'CREATE TABLE assistant_usage_events (session_id TEXT, model TEXT, input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER, reasoning_tokens INTEGER, total_nano_aiu INTEGER)',
    );
    writer.prepare('INSERT INTO assistant_usage_events VALUES (?, ?, ?, ?, ?, ?, ?)').run('app-1', 'gpt-5', 500, 40, 300, 0, 1);
    writer.close();
    const result = new CopilotCliSource(config(), env, 'app').getSessionDetail('app-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.summary).toMatchObject({ source: 'copilot-app', inputTokens: 500, outputTokens: 40, cachedTokens: 300, title: 'Plan' });
      expect(result.value.summary.costMicros).toBeGreaterThan(0);
      expect(result.value.agentUsage[0]?.agentName).toBe('copilot-app');
    }
  });

  it('a CLI-built session still reads as copilot-cli', () => {
    const detail = buildCliSessionDetail({ sessionId: 'x', events: [ev('user.message', { content: 'hi' }, 0)], workspace: {}, repository: 'unknown' });
    expect(detail.summary.source).toBe('copilot-cli');
  });
});
