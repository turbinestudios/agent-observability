import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { copilotHelperCwd, defaultCopilotCliFs, type CopilotCliFs } from '@agent-observability/core/src/copilotCli/paths';
import { buildOutcomeRows } from '@agent-observability/core/src/team/teamShardBuilder';
import type { RpcEvent, SessionRow } from '../../shared/rpc';
import { LiveBoardService } from '../live/liveBoard';
import { applySettingsPatch, buildSettingsSnapshot } from '../settings';
import { DesktopSettingsReader } from '../drivers/desktopConfig';
import { collectAggregationRows } from '../team/teamShardSource';
import { CopilotCliIndexer, dropCopilotDuplicates } from './copilotCliIndexer';
import { IndexDb } from './indexDb';

/**
 * The Copilot CLI source end to end against a temp Copilot home and a temp
 * index. Nothing here reads the real `~/.copilot`.
 */
const T0 = Date.UTC(2026, 9, 6, 10, 0, 0);
let home: string;
let env: CopilotCliFs;
let db: IndexDb;

const line = (type: string, data: Record<string, unknown>, offsetMs: number): string =>
  JSON.stringify({ type, data, timestamp: new Date(T0 + offsetMs).toISOString() });

function writeSession(id: string, lines: string[] | undefined, workspace: string): string {
  const dir = path.join(home, '.copilot', 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workspace.yaml'), workspace);
  const file = path.join(dir, 'events.jsonl');
  if (lines !== undefined) {
    fs.writeFileSync(file, lines.join('\n') + '\n');
  }
  return file;
}

function config(overrides: Record<string, unknown> = {}): Configuration {
  return new Configuration({
    get: <T,>(key: string, fallback: T): T => (overrides[key] === undefined ? fallback : (overrides[key] as T)),
    onDidChange: () => ({ dispose: () => undefined }),
  });
}

const realLines = (): string[] => [
  line('user.message', { content: 'Fix it' }, 0),
  line('assistant.message', { model: 'gpt-5', outputTokens: 9 }, 1000),
  line('user.message', { content: 'And test it' }, 2000),
  line('session.shutdown', { modelMetrics: { 'gpt-5': { requests: { count: 1 }, usage: { inputTokens: 100, outputTokens: 9, cacheReadTokens: 10 } } }, totalNanoAiu: 2_000_000_000 }, 3000),
];

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-cli-index-'));
  env = { ...defaultCopilotCliFs, homedir: () => home, env: {} };
  db = new IndexDb(path.join(home, 'index.db'));
  writeSession('real', realLines(), 'repository: o/repo\nname: Fix the thing\ncwd: ' + path.join(home, 'repo'));
  writeSession('stub', undefined, 'cwd: ' + home);
  writeSession('helper', [line('user.message', { content: 'q' }, 0), line('assistant.message', {}, 500)], 'cwd: ' + copilotHelperCwd(env));
});

afterEach(() => {
  vi.useRealTimers();
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

describe('CopilotCliIndexer', () => {
  it('indexes real sessions only: no row for a stub directory or for a helper run', () => {
    const pushed: SessionRow[] = [];
    const result = new CopilotCliIndexer({ db, config: config(), fs: env, onRows: (rows) => pushed.push(...rows) }).run();
    expect(result).toMatchObject({ discovered: 1, hydrated: 1, helperRuns: 1 });
    const row = db.getRow('copilot-cli', 'real');
    expect(row).toMatchObject({
      repository: 'https://github.com/o/repo',
      title: 'Fix the thing',
      llmCalls: 1,
      inputTokens: 100,
      outputTokens: 9,
      cachedTokens: 10,
      costMicros: 20_000,
    });
    expect(row?.pending).not.toBe(true);
    expect(db.getRow('copilot-cli', 'helper')).toBeUndefined();
    expect(db.getRow('copilot-cli', 'stub')).toBeUndefined();
    expect(pushed.map((r) => r.sessionId)).toEqual(['real']);
  });

  it('re-parses only when the events file changed', () => {
    const indexer = new CopilotCliIndexer({ db, config: config(), fs: env });
    indexer.run();
    expect(new CopilotCliIndexer({ db, config: config(), fs: env }).run().hydrated).toBe(0);
    const file = writeSession('real', [...realLines(), line('user.message', { content: 'again' }, 9000)], 'repository: o/repo');
    expect(fs.statSync(file).size).toBeGreaterThan(0);
    expect(new CopilotCliIndexer({ db, config: config(), fs: env }).run().hydrated).toBe(1);
  });

  it('removes rows for sessions that vanished and indexes nothing when turned off', () => {
    new CopilotCliIndexer({ db, config: config(), fs: env }).run();
    fs.rmSync(path.join(home, '.copilot', 'session-state', 'real'), { recursive: true, force: true });
    new CopilotCliIndexer({ db, config: config(), fs: env }).run();
    expect(db.getRow('copilot-cli', 'real')).toBeUndefined();
    expect(new CopilotCliIndexer({ db, config: config({ 'copilotCli.enabled': false }), fs: env }).run().discovered).toBe(0);
  });

  it('keeps the CLI row when the VS Code Copilot source holds the same session id', () => {
    new CopilotCliIndexer({ db, config: config(), fs: env }).run();
    const cli = db.getRow('copilot-cli', 'real') as SessionRow;
    db.upsertSessions([{ ...cli, source: 'copilot' }, { ...cli, source: 'copilot', sessionId: 'only-vscode' }]);
    expect(dropCopilotDuplicates(db)).toBe(1);
    expect(db.getRow('copilot', 'real')).toBeUndefined();
    expect(db.getRow('copilot', 'only-vscode')).toBeDefined();
    expect(db.getRow('copilot-cli', 'real')).toBeDefined();
  });
});

describe('Copilot CLI on the live board', () => {
  function board(nowMs: number, events: RpcEvent[] = []): LiveBoardService {
    return new LiveBoardService({
      db,
      config: config({ 'claudeCode.enabled': false, 'localTelemetry.enabled': false }),
      hidden: { all: () => [], isHidden: () => false },
      renames: { apply: (rows) => rows },
      emit: (event) => events.push(event),
      requestIndex: () => undefined,
      now: () => nowMs,
      factories: { transcripts: { watch: () => ({ dispose: () => undefined }) }, databases: { watch: () => ({ dispose: () => undefined }) } },
      copilotCliSessions: () => {
        const dir = path.join(home, '.copilot', 'session-state');
        return ['real', 'helper', 'asking'].map((id) => ({
          sessionId: id,
          dir: path.join(dir, id),
          eventsFile: path.join(dir, id, 'events.jsonl'),
          workspaceFile: path.join(dir, id, 'workspace.yaml'),
          size: 1,
          mtimeMs: T0 + 3000,
        }));
      },
      copilotCliRoot: () => path.join(home, '.copilot', 'session-state'),
      copilotCliHelperCwd: () => copilotHelperCwd(env),
    });
  }

  it('shows a finished and an approval-waiting session with index figures, and never the helper', () => {
    vi.useFakeTimers();
    new CopilotCliIndexer({ db, config: config(), fs: env }).run();
    writeSession(
      'asking',
      [
        line('assistant.message', { model: 'gpt-5', toolRequests: [{ toolCallId: 'a', name: 'bash' }] }, 1000),
        line('tool.execution_start', { toolCallId: 'a', toolName: 'bash' }, 2000),
        line('permission.requested', { requestId: 'r', permissionRequest: { kind: 'shell', fullCommandText: 'do-not-show' } }, 3000),
      ],
      'repository: o/repo\nbranch: main',
    );
    const live = board(T0 + 10 * 60_000);
    live.start();
    const rows = live.snapshot().rows;
    live.stop();
    expect(rows.map((r) => r.sessionId).sort()).toEqual(['asking', 'real']);
    const asking = rows.find((r) => r.sessionId === 'asking');
    expect(asking).toMatchObject({ source: 'copilot-cli', status: 'waiting', lastEvent: 'tool-pending', pendingTools: ['bash'], branch: 'main', repository: 'https://github.com/o/repo' });
    expect(JSON.stringify(rows)).not.toContain('do-not-show');
    expect(rows.find((r) => r.sessionId === 'real')).toMatchObject({ status: 'finished', title: 'Fix the thing', inputTokens: 100, costMicros: 20_000 });
  });
});

describe('settings and sharing', () => {
  it('toggles the source through Settings and reports the copilot domain', () => {
    const settings = new DesktopSettingsReader(path.join(home, 'config.json'));
    const seams = {
      pickCopilots: () => [],
      copilotCandidates: () => [],
      exists: () => false,
      configPath: path.join(home, 'config.json'),
      jetbrainsStores: () => [],
    };
    expect(buildSettingsSnapshot(settings, new Configuration(settings), seams).copilotCliEnabled).toBe(true);
    expect(applySettingsPatch(settings, { copilotCliEnabled: false }).copilot).toBe(true);
    expect(buildSettingsSnapshot(settings, new Configuration(settings), seams).copilotCliEnabled).toBe(false);
    expect(applySettingsPatch(settings, { copilotCliEnabled: 'no' as unknown as boolean }).copilot).toBe(false);
  });

  it('counts in a team shard: its aggregation rows are collected like any other source', () => {
    let asked = 0;
    const cli = { id: 'copilot-cli', getAggregationRows: () => ((asked += 1), { ok: true as const, value: [] }) };
    const rows = collectAggregationRows(
      {
        db,
        sources: { enabled: () => [cli as never], get: () => cli as never },
        hidden: { all: () => [], isHidden: () => false },
        policy: { mode: 'all', repositories: new Set() },
      },
      0,
      T0,
    );
    expect(rows).toEqual([]);
    expect(asked).toBe(1);
  });

  it('counts in a team shard: its sessions become outcome rows under their own source', () => {
    const rows = buildOutcomeRows(
      [{ endedAtMs: T0, repository: 'https://github.com/o/repo', source: 'copilot-cli', verdict: 'smooth', costMicros: 1, costMode: 'aiu' }],
      `dev_${'a'.repeat(32)}`,
      T0 - 1000,
      T0 + 1000,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ source: 'copilot-cli', sessionCount: 1, costMode: 'aiu' });
    // A source outside the closed set is still dropped, never renamed.
    expect(
      buildOutcomeRows(
        [{ endedAtMs: T0, repository: 'https://github.com/o/repo', source: 'copilot-cloud', verdict: 'smooth', costMicros: 1, costMode: 'usd' }],
        `dev_${'a'.repeat(32)}`,
        T0 - 1000,
        T0 + 1000,
      ),
    ).toEqual([]);
  });
});
