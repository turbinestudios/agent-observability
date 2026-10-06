import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { defaultCopilotCliFs, type CopilotCliFs } from '@agent-observability/core/src/copilotCli/paths';
import { CopilotJetbrainsSource } from '@agent-observability/core/src/copilotJetbrains/copilotJetbrainsSource';
import type { SessionRow } from '../../shared/rpc';
import { LiveBoardService } from '../live/liveBoard';
import { collectAggregationRows, shardSource } from '../team/teamShardSource';
import { describeDeletion } from '../deletion';
import { CopilotCliIndexer } from './copilotCliIndexer';
import { CopilotJetbrainsIndexer } from './copilotJetbrainsIndexer';
import { IndexDb } from './indexDb';

/**
 * The GitHub Copilot app and Copilot in JetBrains IDEs, end to end against a
 * temp home and a temp index. Nothing here reads the real `~/.copilot` or the
 * real JetBrains plugin folder.
 */
const T0 = Date.UTC(2026, 8, 30, 12, 0, 0);
let home: string;
let env: CopilotCliFs;
let db: IndexDb;

const line = (type: string, data: Record<string, unknown>, offsetMs: number): string =>
  JSON.stringify({ type, data, timestamp: new Date(T0 + offsetMs).toISOString() });

function writeSession(id: string, workspace: string): string {
  const dir = path.join(home, '.copilot', 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), workspace);
  const file = path.join(dir, 'events.jsonl');
  fs.writeFileSync(file, [line('user.message', { content: 'Plan it' }, 0), line('assistant.message', { model: 'gpt-5', outputTokens: 4 }, 1000)].join('\n') + '\n');
  return file;
}

function config(overrides: Record<string, unknown> = {}): Configuration {
  return new Configuration({
    get: <T,>(key: string, fallback: T): T => (overrides[key] === undefined ? fallback : (overrides[key] as T)),
    onDidChange: () => ({ dispose: () => undefined }),
  });
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-app-index-'));
  env = { ...defaultCopilotCliFs, homedir: () => home, env: {} };
  db = new IndexDb(path.join(home, 'index.db'));
  writeSession('app-1', 'client_name: github/autopilot\nname: Customer journey\nrepository: o/app');
  writeSession('cli-1', 'client_name: github/cli\nname: Fix the thing\nrepository: o/cli');
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

const runBoth = (cfg = config()): void => {
  new CopilotCliIndexer({ db, config: cfg, fs: env }).run();
  new CopilotCliIndexer({ db, config: cfg, fs: env, client: 'app' }).run();
};

describe('Copilot app indexing', () => {
  it('files each session under its own source', () => {
    runBoth();
    expect(db.getRow('copilot-app', 'app-1')).toMatchObject({ title: 'Customer journey', repository: 'https://github.com/o/app' });
    expect(db.getRow('copilot-cli', 'app-1')).toBeUndefined();
    expect(db.getRow('copilot-cli', 'cli-1')).toBeDefined();
    expect(db.getRow('copilot-app', 'cli-1')).toBeUndefined();
  });

  it('moves a session an older release filed under the CLI, though its file is unchanged', () => {
    // What 2.1 did: the CLI indexer took every session in the store.
    const file = path.join(home, '.copilot', 'session-state', 'app-1', 'events.jsonl');
    const stat = fs.statSync(file);
    const old = { source: 'copilot-cli', sessionId: 'app-1', repository: 'unknown', startedAtMs: T0, endedAtMs: T0, durationMs: 0, interactionCount: 1, llmCalls: 1, toolCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, model: 'gpt-5', agentModes: ['agent'], indexedAtMs: T0, pending: false } as SessionRow;
    db.upsertHydratedSessions([
      { row: old, file: { path: file, source: 'copilot-cli', sessionId: 'app-1', kind: 'main', size: stat.size, mtimeMs: stat.mtimeMs, headHash: null, parsedBytes: stat.size, accState: null } },
    ]);
    runBoth();
    expect(db.getRow('copilot-cli', 'app-1')).toBeUndefined();
    expect(db.getRow('copilot-app', 'app-1')).toMatchObject({ repository: 'https://github.com/o/app' });
    // And it stays put on the next pass.
    runBoth();
    expect(db.getRow('copilot-app', 'app-1')).toBeDefined();
    expect(db.getRow('copilot-cli', 'app-1')).toBeUndefined();
  });

  it('turns off on its own, leaving the CLI alone', () => {
    const off = config({ 'copilotApp.enabled': false });
    expect(new CopilotCliIndexer({ db, config: off, fs: env, client: 'app' }).run().discovered).toBe(0);
    expect(new CopilotCliIndexer({ db, config: off, fs: env }).run().discovered).toBe(1);
  });

  it('is shared in a team shard as a Copilot CLI session', () => {
    expect(shardSource('copilot-app')).toBe('copilot-cli');
    expect(shardSource('claude')).toBe('claude');
    expect(shardSource('copilot-jetbrains')).toBe('copilot-jetbrains');
    let asked = 0;
    const app = { id: 'copilot-app', getAggregationRows: () => ((asked += 1), { ok: true as const, value: [] }) };
    const jetbrains = { id: 'copilot-jetbrains', getAggregationRows: () => ((asked += 10), { ok: true as const, value: [] }) };
    collectAggregationRows(
      {
        db,
        sources: { enabled: () => [app as never, jetbrains as never], get: () => undefined },
        hidden: { all: () => [], isHidden: () => false },
        policy: { mode: 'all', repositories: new Set() },
      },
      0,
      T0,
    );
    // The app is collected; JetBrains is never shared.
    expect(asked).toBe(1);
  });

  it('is never deleted from the app’s own store', () => {
    expect(describeDeletion('copilot-app', 'app-1', { config: config() } as never).supported).toBe(false);
    expect(describeDeletion('copilot-jetbrains', 'x', { config: config() } as never).supported).toBe(false);
  });

  it('shows on the live board under its own source', () => {
    runBoth();
    const dir = path.join(home, '.copilot', 'session-state');
    const live = new LiveBoardService({
      db,
      config: config({ 'claudeCode.enabled': false, 'localTelemetry.enabled': false, 'copilotJetbrains.enabled': false }),
      hidden: { all: () => [], isHidden: () => false },
      renames: { apply: (rows) => rows },
      emit: () => undefined,
      requestIndex: () => undefined,
      now: () => T0 + 60_000,
      factories: { transcripts: { watch: () => ({ dispose: () => undefined }) }, databases: { watch: () => ({ dispose: () => undefined }) } },
      copilotCliSessions: () =>
        ['app-1', 'cli-1'].map((id) => ({
          sessionId: id,
          dir: path.join(dir, id),
          eventsFile: path.join(dir, id, 'events.jsonl'),
          workspaceFile: path.join(dir, id, 'workspace.yaml'),
          size: 1,
          mtimeMs: T0 + 1000,
        })),
      copilotCliRoot: () => dir,
      copilotCliHelperCwd: () => path.join(home, 'helper-cwd'),
    });
    live.start();
    const rows = live.snapshot().rows;
    live.stop();
    expect(rows.map((r) => [r.sessionId, r.source]).sort()).toEqual([
      ['app-1', 'copilot-app'],
      ['cli-1', 'copilot-cli'],
    ]);
  });
});

describe('Copilot (JetBrains) indexing', () => {
  const GUID = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const str = (value: string): Buffer => {
    const bytes = Buffer.from(value, 'utf8');
    const head = Buffer.alloc(3);
    head[0] = 0x74;
    head.writeUInt16BE(bytes.length, 1);
    return Buffer.concat([head, bytes]);
  };
  const cls = (name: string): Buffer => {
    const head = Buffer.alloc(3);
    head[0] = 0x72;
    head.writeUInt16BE(name.length, 1);
    return Buffer.concat([head, Buffer.from(name, 'latin1'), Buffer.alloc(8)]);
  };
  const store = (title: string): Buffer =>
    Buffer.concat([
      Buffer.from('H:2,block:9,format:3,', 'latin1'),
      cls('x.NtAgentSession'),
      str(GUID),
      str('title'),
      str(title),
      cls('x.NtAgentTurn'),
      cls('x.Markdown'),
      str('text'),
      str('Question'),
      cls('x.AgentRound'),
      str('reply'),
      str('Answer'),
    ]);

  let root: string;
  let file: string;
  let locked = false;
  const source = (): CopilotJetbrainsSource =>
    new CopilotJetbrainsSource(
      { isCopilotJetbrainsEnabled: () => true, getCopilotJetbrainsStorePath: () => root, getExcludedRepositories: () => new Set() },
      { ...env, platform: 'win32' },
      (p) => {
        if (locked) {
          throw new Error('EBUSY');
        }
        return fs.readFileSync(p);
      },
    );

  beforeEach(() => {
    root = path.join(home, 'github-copilot');
    file = path.join(root, 'Rider2026.2', 'chat-agent-sessions', 'p1', 'copilot-agent-sessions-nitrite.db');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, store('First title'));
    locked = false;
  });

  it('indexes every conversation in a store, and skips an unchanged store', () => {
    const first = new CopilotJetbrainsIndexer({ db, config: config(), source: source() }).run();
    expect(first).toMatchObject({ stores: 1, discovered: 1, hydrated: 1, unreadable: 0 });
    expect(db.getRow('copilot-jetbrains', GUID)).toMatchObject({ title: 'First title', inputTokens: 0, llmCalls: 1 });
    expect(new CopilotJetbrainsIndexer({ db, config: config(), source: source() }).run().hydrated).toBe(0);
  });

  it('re-reads a store that changed', () => {
    new CopilotJetbrainsIndexer({ db, config: config(), source: source() }).run();
    fs.writeFileSync(file, store('A much longer, renamed title'));
    expect(new CopilotJetbrainsIndexer({ db, config: config(), source: source() }).run().hydrated).toBe(1);
    expect(db.getRow('copilot-jetbrains', GUID)?.title).toBe('A much longer, renamed title');
  });

  it('keeps what it had when the IDE holds the file, and drops sessions whose store is gone', () => {
    new CopilotJetbrainsIndexer({ db, config: config(), source: source() }).run();
    fs.writeFileSync(file, store('Changed while locked'));
    locked = true;
    expect(new CopilotJetbrainsIndexer({ db, config: config(), source: source() }).run().unreadable).toBe(1);
    expect(db.getRow('copilot-jetbrains', GUID)?.title).toBe('First title');
    locked = false;
    fs.rmSync(file);
    new CopilotJetbrainsIndexer({ db, config: config(), source: source() }).run();
    expect(db.getRow('copilot-jetbrains', GUID)).toBeUndefined();
  });

  it('counts a store it cannot make sense of as unreadable', () => {
    fs.writeFileSync(file, Buffer.alloc(4096, 0x41));
    expect(new CopilotJetbrainsIndexer({ db, config: config(), source: source() }).run()).toMatchObject({ discovered: 0, unreadable: 1 });
  });
});
