import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import type { CopilotCliFs } from '../copilotCli/paths';
import { opencodeAgentMode, opencodeModel } from './mapper';
import { OpencodeSource } from './opencodeSource';
import { opencodeDbPath } from './paths';

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
 * OpenCode's `opencode.db` as opencode 2.1.2 wrote it in October 2026: the
 * DDL below is the real one, cut to the columns read. One session runs on a
 * GitHub Copilot login with an `explore` sub-agent; one runs on OpenAI. The
 * credential table is present so a test can show it is never read.
 */
const DDL = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text NOT NULL, version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL,
  time_updated integer NOT NULL, data text NOT NULL);
CREATE TABLE credential (id text PRIMARY KEY, label text NOT NULL, value text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
`;

const T0 = 1_790_000_000_000;

let root: string;
let dbPath: string;

function seed(): void {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(DDL);
  const repo = path.join(root, 'repo');
  db.prepare('INSERT INTO project VALUES (?, ?, ?, ?)').run('prj', repo, T0, T0);
  const session = db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  session.run('ses_copilot', 'prj', null, 's1', repo, 'Fix the login form', '2.1.2', T0, T0 + 60_000);
  session.run('ses_child', 'prj', 'ses_copilot', 's2', repo, 'Child session - 2026-09-21T10:00:00.000Z', '2.1.2', T0 + 5_000, T0 + 9_000);
  session.run('ses_openai', 'prj', null, 's3', repo, 'New session - 2026-09-21T11:00:00.000Z', '2.1.2', T0 + 100_000, T0 + 110_000);
  db.prepare('INSERT INTO credential VALUES (?, ?, ?, ?, ?)').run('c1', 'github-copilot', 'gho_secret', T0, T0);
  const message = db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)');
  const msg = (id: string, sessionId: string, at: number, data: Record<string, unknown>): void => {
    message.run(id, sessionId, at, at, JSON.stringify(data));
  };
  const assistant = (providerID: string, modelID: string, parentID: string, at: number, extra: Record<string, unknown>) => ({
    role: 'assistant',
    providerID,
    modelID,
    parentID,
    time: { created: at, completed: at + 2_000 },
    ...extra,
  });
  const tokens = (input: number, output: number, read: number, write = 0) => ({
    input,
    output,
    reasoning: 7,
    cache: { read, write },
  });
  msg('m1', 'ses_copilot', T0, { role: 'user', agent: 'build', model: { providerID: 'github-copilot', modelID: 'claude-sonnet-4.5' }, time: { created: T0 } });
  msg('m2', 'ses_copilot', T0 + 1_000, assistant('github-copilot', 'claude-sonnet-4.5', 'm1', T0 + 1_000, { agent: 'build', tokens: tokens(1_000, 100, 4_000, 50), cost: 0 }));
  msg('m3', 'ses_copilot', T0 + 10_000, assistant('github-copilot', 'claude-sonnet-4.5', 'm1', T0 + 10_000, { agent: 'build', tokens: tokens(500, 80, 6_000), cost: 0 }));
  msg('c1', 'ses_child', T0 + 5_000, { role: 'user', agent: 'explore', time: { created: T0 + 5_000 } });
  msg('c2', 'ses_child', T0 + 6_000, assistant('github-copilot', 'gpt-5-mini', 'c1', T0 + 6_000, { agent: 'explore', tokens: tokens(300, 30, 0), cost: 0 }));
  msg('o1', 'ses_openai', T0 + 100_000, { role: 'user', agent: 'plan', time: { created: T0 + 100_000 } });
  msg('o2', 'ses_openai', T0 + 101_000, assistant('openai', 'gpt-5.4', 'o1', T0 + 101_000, { agent: 'plan', tokens: tokens(2_000, 200, 0), cost: 0.0125 }));
  msg('o3', 'ses_openai', T0 + 104_000, assistant('openai', 'gpt-5.4', 'o1', T0 + 104_000, { agent: 'plan', tokens: tokens(100, 10, 0), cost: 0.001, error: { name: 'APIError' } }));
  const part = db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)');
  const p = (id: string, messageId: string, sessionId: string, at: number, data: Record<string, unknown>): void => {
    part.run(id, messageId, sessionId, at, at, JSON.stringify(data));
  };
  p('p1', 'm1', 'ses_copilot', T0, { type: 'text', text: 'Fix the login form validation' });
  p('p1s', 'm1', 'ses_copilot', T0, { type: 'text', text: 'injected reminder', synthetic: true });
  p('p2', 'm2', 'ses_copilot', T0 + 1_500, { type: 'tool', tool: 'read', callID: 'x', state: { status: 'completed', input: { filePath: '/secret' }, output: 'file body', time: { start: T0 + 1_500, end: T0 + 1_600 } } });
  p('p3', 'm2', 'ses_copilot', T0 + 2_000, { type: 'tool', tool: 'task', callID: 'y', state: { status: 'completed', time: { start: T0 + 2_000, end: T0 + 9_500 } } });
  p('p4', 'm3', 'ses_copilot', T0 + 11_000, { type: 'text', text: 'Done: the form now validates.' });
  p('p5', 'c2', 'ses_child', T0 + 6_500, { type: 'tool', tool: 'grep', callID: 'z', state: { status: 'error', time: { start: T0 + 6_500, end: T0 + 6_600 } } });
  p('p6', 'o1', 'ses_openai', T0 + 100_000, { type: 'text', text: 'Plan   the\nrelease notes' });
  db.close();
}

const config = (enabled = true, excluded: string[] = []) => ({
  isOpencodeEnabled: () => enabled,
  getOpencodeDbPath: () => dbPath,
  getExcludedRepositories: () => new Set(excluded),
});

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-opencode-'));
  dbPath = path.join(root, 'opencode.db');
  seed();
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const ok = <T>(result: { ok: true; value: T } | { ok: false; message: string }): T => {
  if (!result.ok) {
    throw new Error(result.message);
  }
  return result.value;
};

describe('opencodeDbPath', () => {
  const env = (vars: Record<string, string | undefined>): CopilotCliFs => ({
    homedir: () => path.join(root, 'home'),
    env: vars,
    readDir: () => [],
    stat: () => undefined,
  });

  it('defaults to the XDG data folder under the home directory on every platform', () => {
    expect(opencodeDbPath(undefined, env({}))).toBe(path.join(root, 'home', '.local', 'share', 'opencode', 'opencode.db'));
  });

  it('follows XDG_DATA_HOME, then OPENCODE_DB, then the Settings override', () => {
    const xdg = path.join(root, 'xdg');
    expect(opencodeDbPath(undefined, env({ XDG_DATA_HOME: xdg }))).toBe(path.join(xdg, 'opencode', 'opencode.db'));
    expect(opencodeDbPath(undefined, env({ XDG_DATA_HOME: xdg, OPENCODE_DB: 'opencode-dev.db' }))).toBe(
      path.join(xdg, 'opencode', 'opencode-dev.db'),
    );
    const absolute = path.join(root, 'elsewhere.db');
    expect(opencodeDbPath(undefined, env({ OPENCODE_DB: absolute }))).toBe(absolute);
    expect(opencodeDbPath(` ${dbPath} `, env({ OPENCODE_DB: absolute }))).toBe(dbPath);
  });
});

describe('OpencodeSource', { timeout: 30_000 }, () => {
  it('lists root sessions newest first, with sub-agent sessions folded in', () => {
    const sessions = ok(new OpencodeSource(config()).listSessions());
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_openai', 'ses_copilot']);
    expect(sessions.every((s) => s.source === 'opencode')).toBe(true);
  });

  it('shows a Copilot-served session by provider and leaves it unpriced, not $0', () => {
    const detail = ok(new OpencodeSource(config()).getSessionDetail('ses_copilot'));
    const s = detail.summary;
    expect(s.model).toBe('github-copilot/claude-sonnet-4.5');
    expect(s.costMicros).toBeUndefined();
    expect(detail.treeStats.costUsdMicros).toBeUndefined();
    expect(s.title).toBe('Fix the login form');
    expect(s.titleDerived).toBe(false);
    expect(s.agentModes).toEqual(['agent']);
    // Main thread: input counts cache writes, cached counts cache reads.
    expect([s.llmCalls, s.toolCalls, s.inputTokens, s.outputTokens, s.cachedTokens]).toEqual([2, 2, 1_550, 180, 10_000]);
    expect(s.startedAtMs).toBe(T0);
    expect(s.endedAtMs).toBe(T0 + 12_000);
  });

  it('counts the sub-agent in the tree and names it by its agent', () => {
    const detail = ok(new OpencodeSource(config()).getSessionDetail('ses_copilot'));
    expect(detail.treeStats).toMatchObject({ modelTurns: 3, toolCalls: 3, inputTokens: 1_850, errorCount: 1 });
    expect(detail.agentUsage.map((a) => [a.agentName, a.kind, a.model, a.llmCalls])).toEqual([
      ['opencode', 'main', 'github-copilot/claude-sonnet-4.5', 2],
      ['explore', 'subagent', 'github-copilot/gpt-5-mini', 1],
    ]);
    expect(detail.treeModelTurns).toHaveLength(3);
  });

  it('groups a turn as the prompt plus every reply to it, skipping synthetic text', () => {
    const [turn] = ok(new OpencodeSource(config()).getSessionDetail('ses_copilot')).turns;
    expect(turn.userRequest).toBe('Fix the login form validation');
    expect(turn.finalResponse).toBe('Done: the form now validates.');
    expect(turn.llmCalls).toBe(2);
    expect(turn.events.map((e) => [e.operation, e.toolName])).toEqual([
      ['chat', undefined],
      ['execute_tool', 'read'],
      ['execute_tool', 'task'],
      ['chat', undefined],
    ]);
  });

  it('prices other providers from the recorded cost and marks errors', () => {
    const detail = ok(new OpencodeSource(config()).getSessionDetail('ses_openai'));
    expect(detail.summary.costMicros).toBe(13_500);
    expect(detail.summary.model).toBe('openai/gpt-5.4');
    expect(detail.summary.agentModes).toEqual(['ask']);
    expect(detail.turns[0].success).toBe(false);
    expect(detail.treeStats.errorCount).toBe(1);
  });

  it('derives a title from the first prompt while OpenCode still shows its placeholder', () => {
    const s = ok(new OpencodeSource(config()).getSessionDetail('ses_openai')).summary;
    expect(s.title).toBe('Plan the release notes');
    expect(s.titleDerived).toBe(true);
  });

  it('emits content-free aggregation rows with mapped tool names', () => {
    const rows = ok(new OpencodeSource(config()).getAggregationRows());
    // Copilot session: 2 chats + 2 tools; its sub-agent: 1 + 1; OpenAI session: 2 chats.
    expect(rows).toHaveLength(8);
    expect(JSON.stringify(rows)).not.toContain('secret');
    expect(JSON.stringify(rows)).not.toContain('login form');
    expect(rows.filter((r) => r.operation === 'execute_tool').every((r) => typeof r.toolName === 'string')).toBe(true);
  });

  it('never reads the credential table or tool payloads', () => {
    const source = new OpencodeSource(config());
    const all = [
      ...ok(source.getSessionInteractions('ses_copilot')),
      ok(source.getSessionDetail('ses_copilot')),
    ];
    expect(JSON.stringify(all)).not.toContain('gho_secret');
    expect(JSON.stringify(all)).not.toContain('file body');
  });

  it('leaves the database untouched', () => {
    const before = fs.readFileSync(dbPath);
    ok(new OpencodeSource(config()).listSessions());
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
  });

  it('honours excluded repositories, the switch, and a missing file', () => {
    const repo = ok(new OpencodeSource(config()).listSessions())[0].repository;
    expect(ok(new OpencodeSource(config(true, [repo])).listSessions())).toEqual([]);
    expect(new OpencodeSource(config(false)).listSessions()).toMatchObject({ ok: false, reason: 'disabled' });
    dbPath = path.join(root, 'absent.db');
    expect(new OpencodeSource(config()).listSessions()).toMatchObject({ ok: false, reason: 'missingDb' });
  });
});

describe('mapping helpers', () => {
  it('maps OpenCode agents onto the fixed mode set', () => {
    expect(opencodeAgentMode('build')).toBe('agent');
    expect(opencodeAgentMode('Plan')).toBe('ask');
    expect(opencodeAgentMode('reviewer')).toBe('custom');
    expect(opencodeAgentMode(undefined)).toBe('default');
  });

  it('qualifies the model with its provider', () => {
    expect(opencodeModel({ providerId: 'github-copilot', modelId: 'gpt-5' })).toBe('github-copilot/gpt-5');
    expect(opencodeModel({ modelId: 'gpt-5' })).toBe('gpt-5');
    expect(opencodeModel({})).toBe('unknown');
  });
});
