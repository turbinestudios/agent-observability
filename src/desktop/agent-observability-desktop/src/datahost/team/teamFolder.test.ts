import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildTeamShard } from '@agent-observability/core/src/team/teamShardBuilder';
import type { TeamShard } from '@agent-observability/core/src/team/teamShardModels';
import { TEAM_POLL_MS, TeamFolderWatcher, readTeamFolder } from './teamFolder';

const DEV_A = `dev_${'a'.repeat(32)}`;
const DEV_B = `dev_${'b'.repeat(32)}`;
const START = Date.UTC(2026, 8, 1);
const END = Date.UTC(2026, 9, 1);

let dir: string;

function shard(devId: string, generatedAtMs = Date.UTC(2026, 9, 1, 12)): TeamShard {
  return buildTeamShard({
    rows: [],
    observations: [],
    outcomes: [
      {
        endedAtMs: Date.UTC(2026, 8, 15, 10),
        repository: 'https://github.com/o/repo',
        source: 'claude',
        verdict: 'smooth',
        costMicros: 1000,
        costMode: 'usd',
      },
    ],
    pseudonymousDeveloperId: devId,
    toolVersion: '1.17.0',
    windowStartMs: START,
    windowEndMs: END,
    generatedAtMs,
  });
}

function write(name: string, content: string): void {
  fs.writeFileSync(path.join(dir, name), content, 'utf8');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-team-folder-'));
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('readTeamFolder', () => {
  it('merges valid shards named after their member and reports the rest', () => {
    write(`${DEV_A}.json`, JSON.stringify(shard(DEV_A)));
    write(`${DEV_B}.json`, JSON.stringify({ ...shard(DEV_B), schemaVersion: '9.0' }));
    write(`dev_${'c'.repeat(32)}.json`, JSON.stringify(shard(DEV_A)));
    write(`dev_${'d'.repeat(32)}.json`, '{ not json');
    write(`dev_${'e'.repeat(32)}.json`, JSON.stringify({ ...shard(`dev_${'e'.repeat(32)}`), extra: 1 }));
    write('notes.txt', 'ignored');
    write(`${DEV_A}.json.tmp`, 'ignored');

    const read = readTeamFolder(dir);
    expect(read.folderState).toBe('ok');
    expect([...read.merged.members.keys()]).toEqual([DEV_A]);
    const reasons = Object.fromEntries(read.problems.map((p) => [p.fileName.slice(4, 5), p.reason]));
    expect(reasons).toEqual({ b: 'unknown-schema-version', c: 'id-mismatch', d: 'unreadable', e: 'invalid' });
    expect(read.files.map((f) => f.fileName).sort()).toHaveLength(5);
  });

  it('reports a missing folder without throwing', () => {
    expect(readTeamFolder(path.join(dir, 'nope')).folderState).toBe('missing');
    const file = path.join(dir, 'file');
    fs.writeFileSync(file, 'x');
    expect(readTeamFolder(file).folderState).toBe('missing');
  });

  it('skips files over the size limit before parsing them', () => {
    const io = {
      statSync: (p: string) =>
        p === dir
          ? { isDirectory: () => true, isFile: () => false, size: 0, mtimeMs: 0 }
          : { isDirectory: () => false, isFile: () => true, size: 17 * 1024 * 1024, mtimeMs: 1 },
      readdirSync: () => [`${DEV_A}.json`],
      readFileSync: (): string => {
        throw new Error('must not read an oversized file');
      },
    };
    const read = readTeamFolder(dir, io);
    expect(read.problems).toEqual([{ fileName: `${DEV_A}.json`, reason: 'too-large', detail: expect.stringContaining('bytes') }]);
  });
});

describe('TeamFolderWatcher', () => {
  it('fires on a changed, added or removed shard found by the poll, and on folder removal', () => {
    vi.useFakeTimers();
    let changes = 0;
    const watcher = new TeamFolderWatcher({
      folder: () => dir,
      onChange: () => void (changes += 1),
      io: {
        statSync: (p) => fs.statSync(p),
        readdirSync: (p) => fs.readdirSync(p),
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
        // No native watch in the test: the poll alone must be correct.
      },
    });
    watcher.start();
    expect(watcher.watchMode()).toBe('poll');

    write(`${DEV_A}.json`, JSON.stringify(shard(DEV_A)));
    vi.advanceTimersByTime(TEAM_POLL_MS);
    expect(changes).toBe(1);

    vi.advanceTimersByTime(TEAM_POLL_MS);
    expect(changes).toBe(1);

    fs.utimesSync(path.join(dir, `${DEV_A}.json`), new Date(0), new Date(60_000));
    vi.advanceTimersByTime(TEAM_POLL_MS);
    expect(changes).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
    vi.advanceTimersByTime(TEAM_POLL_MS);
    expect(changes).toBe(3);
    watcher.stop();
    expect(watcher.watchMode()).toBe('off');
  });

  it('degrades to polling when the native watch cannot be created', () => {
    vi.useFakeTimers();
    const watcher = new TeamFolderWatcher({
      folder: () => dir,
      onChange: () => undefined,
      io: {
        statSync: (p) => fs.statSync(p),
        readdirSync: (p) => fs.readdirSync(p),
        readFileSync: (p, enc) => fs.readFileSync(p, enc),
        watch: (() => {
          throw new Error('EPERM');
        }) as unknown as typeof fs.watch,
      },
    });
    watcher.start();
    expect(watcher.watchMode()).toBe('poll');
    watcher.stop();
  });

  it('does nothing without a folder', () => {
    vi.useFakeTimers();
    let changes = 0;
    const watcher = new TeamFolderWatcher({ folder: () => '', onChange: () => void (changes += 1) });
    watcher.start();
    vi.advanceTimersByTime(TEAM_POLL_MS * 3);
    expect(changes).toBe(0);
    expect(watcher.watchMode()).toBe('off');
  });
});
