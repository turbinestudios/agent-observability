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

/**
 * OpenCode 2.x as it writes today: `session_v2` and `session_message`, one
 * row per message in `seq` order with tool calls inline, beside the 1.x
 * tables it migrated from. The legacy copy of `ses_old` must not be counted
 * a second time.
 */
describe('OpencodeSource on the 2.x layout', { timeout: 30_000 }, () => {
  const V2_DDL = `
CREATE TABLE project (id text PRIMARY KEY, worktree text NOT NULL);
CREATE TABLE session (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, directory text NOT NULL, title text NOT NULL,
  version text NOT NULL, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE message (id text PRIMARY KEY, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);
CREATE TABLE part (id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL, time_created integer NOT NULL, data text NOT NULL);
CREATE TABLE session_v2 (id text PRIMARY KEY, project_id text NOT NULL, parent_id text, slug text NOT NULL, directory text NOT NULL,
  title text, version text NOT NULL, model text, agent text, time_created integer NOT NULL, time_updated integer NOT NULL);
CREATE TABLE session_message (id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
  time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL);
`;

  beforeEach(() => {
    fs.rmSync(dbPath, { force: true });
    fs.rmSync(`${dbPath}-wal`, { force: true });
    fs.rmSync(`${dbPath}-shm`, { force: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec(V2_DDL);
    const repo = path.join(root, 'repo');
    db.prepare('INSERT INTO project VALUES (?, ?)').run('prj', repo);
    // The 1.x row and its message, as left behind after migration.
    db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run('ses_old', 'prj', null, repo, 'Old one', '1.4.3', T0, T0);
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('lm1', 'ses_old', T0, JSON.stringify({ role: 'user', time: { created: T0 } }));
    const session = db.prepare('INSERT INTO session_v2 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    const copilot = JSON.stringify({ id: 'claude-opus-5.5', providerID: 'github-copilot', variant: 'default' });
    session.run('ses_old', 'prj', null, 'a', repo, 'Old one', '1.4.3', copilot, 'build', T0, T0);
    session.run('ses_new', 'prj', null, 'b', repo, 'Ship the parser', '2.1.2', copilot, 'build', T0 + 100_000, T0 + 200_000);
    session.run('ses_sub', 'prj', 'ses_new', 'c', repo, 'Review', '2.1.2', copilot, 'security-reviewer', T0 + 120_000, T0 + 130_000);
    const message = db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)');
    let seq = 0;
    const msg = (id: string, sessionId: string, type: string, at: number, data: Record<string, unknown>): void => {
      message.run(id, sessionId, type, seq++, at, at, JSON.stringify(data));
    };
    const reply = (agent: string, at: number, content: unknown[], extra: Record<string, unknown> = {}) => ({
      agent,
      model: { id: 'claude-opus-5.5', providerID: 'github-copilot', variant: 'default' },
      time: { created: at, completed: at + 2_000 },
      tokens: { input: 10, output: 100, reasoning: 5, cache: { read: 1_000, write: 200 } },
      cost: 0.25,
      content,
      ...extra,
    });
    const tool = (name: string, at: number, status = 'completed') => ({
      type: 'tool',
      id: `t-${name}-${at}`,
      name,
      state: { status, input: { filePath: '/secret/path' }, content: ['tool output body'] },
      time: { created: at, completed: at + 500 },
    });
    msg('o1', 'ses_old', 'user', T0, { text: 'Old prompt', time: { created: T0 } });
    msg('o2', 'ses_old', 'assistant', T0 + 1_000, reply('build', T0 + 1_000, [{ type: 'text', text: 'Old answer' }]));
    msg('n1', 'ses_new', 'user', T0 + 100_000, { text: 'Ship the parser', time: { created: T0 + 100_000 } });
    msg('n1s', 'ses_new', 'synthetic', T0 + 100_001, { text: 'injected instructions', time: { created: T0 + 100_001 } });
    msg('n2', 'ses_new', 'assistant', T0 + 101_000, reply('build', T0 + 101_000, [
      { type: 'reasoning', text: 'private reasoning' },
      tool('read', T0 + 101_500),
      tool('edit', T0 + 102_000, 'error'),
    ]));
    msg('n3', 'ses_new', 'assistant', T0 + 110_000, reply('build', T0 + 110_000, [tool('subagent', T0 + 110_500), { type: 'text', text: 'Shipped.' }]));
    msg('n4', 'ses_new', 'idle', T0 + 140_000, { outcome: 'completed', time: { created: T0 + 140_000 } });
    msg('n5', 'ses_new', 'user', T0 + 150_000, { text: 'Now the tests', time: { created: T0 + 150_000 } });
    msg('n6', 'ses_new', 'assistant', T0 + 151_000, reply('plan', T0 + 151_000, [], { error: { type: 'aborted', message: 'stopped' } }));
    msg('s1', 'ses_sub', 'user', T0 + 120_000, { text: 'Review the diff', time: { created: T0 + 120_000 } });
    msg('s2', 'ses_sub', 'assistant', T0 + 121_000, reply('security-reviewer', T0 + 121_000, [tool('grep', T0 + 121_500)]));
    db.close();
  });

  it('reads the v2 tables and counts a migrated session once', () => {
    const sessions = ok(new OpencodeSource(config()).listSessions());
    expect(sessions.map((s) => s.sessionId)).toEqual(['ses_new', 'ses_old']);
    const old = ok(new OpencodeSource(config()).getSessionDetail('ses_old'));
    expect(old.summary.llmCalls).toBe(1);
    expect(old.turns[0].userRequest).toBe('Old prompt');
  });

  it('groups replies under the prompt before them and reads tools from the message content', () => {
    const detail = ok(new OpencodeSource(config()).getSessionDetail('ses_new'));
    expect(detail.summary.model).toBe('github-copilot/claude-opus-5.5');
    expect(detail.summary.title).toBe('Ship the parser');
    expect(detail.turns.map((t) => [t.userRequest, t.llmCalls, t.success])).toEqual([
      ['Ship the parser', 2, true],
      ['Now the tests', 1, false],
    ]);
    expect(detail.turns[0].finalResponse).toBe('Shipped.');
    expect(detail.turns[0].events.map((e) => e.toolName ?? e.operation)).toEqual(['chat', 'read', 'edit', 'chat', 'subagent']);
    expect(detail.summary.agentModes).toEqual(['agent', 'ask']);
    // Main thread: 3 replies of 10 input + 200 cache writes, 100 output, 1,000 cache reads.
    expect([detail.summary.llmCalls, detail.summary.toolCalls, detail.summary.inputTokens, detail.summary.outputTokens, detail.summary.cachedTokens]).toEqual([
      3, 3, 630, 300, 3_000,
    ]);
  });

  it('keeps Copilot-served turns unpriced although OpenCode records a list-price cost', () => {
    const detail = ok(new OpencodeSource(config()).getSessionDetail('ses_new'));
    expect(detail.summary.costMicros).toBeUndefined();
    expect(detail.treeStats.costUsdMicros).toBeUndefined();
  });

  it('folds the sub-agent session in, named by its agent', () => {
    const detail = ok(new OpencodeSource(config()).getSessionDetail('ses_new'));
    expect(detail.agentUsage.map((a) => [a.agentName, a.kind, a.llmCalls])).toEqual([
      ['opencode', 'main', 3],
      ['security-reviewer', 'subagent', 1],
    ]);
    expect(detail.treeStats).toMatchObject({ modelTurns: 4, toolCalls: 4, errorCount: 2 });
  });

  it('never surfaces tool payloads, reasoning or synthetic text', () => {
    const source = new OpencodeSource(config());
    const all = JSON.stringify([ok(source.getSessionDetail('ses_new')), ok(source.getSessionInteractions('ses_new'))]);
    for (const hidden of ['/secret/path', 'tool output body', 'private reasoning', 'injected instructions']) {
      expect(all).not.toContain(hidden);
    }
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
