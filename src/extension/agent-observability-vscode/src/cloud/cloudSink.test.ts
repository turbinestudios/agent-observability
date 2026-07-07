import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ARCHIVE_DIR_NAME, ArchiveEnv } from '../otel/archivePaths';
import { CloudSink, resolveCloudSinkDir, freshIndex } from './cloudSink';
import {
  CLOUD_PARSER_VERSION,
  CLOUD_SINK_INDEX_VERSION,
  CloudRepoRef,
  CloudTaskIndexEntry,
  SinkIndex,
} from './cloudTypes';

let tmp: string | undefined;
afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

/** A fresh temp sink dir + a CloudSink rooted at it. */
function freshSink(): { sink: CloudSink; dir: string } {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'cloudsink-'));
  return { sink: new CloudSink(tmp), dir: tmp };
}

function mkEntry(
  taskId: string,
  updatedAtMs: number,
  sessionIds: string[],
): CloudTaskIndexEntry {
  return {
    taskId,
    account: 'me',
    repository: 'https://github.com/o/r',
    state: 'completed',
    sessionIds,
    updatedAtMs,
    terminal: true,
  };
}

describe('resolveCloudSinkDir', () => {
  it('uses AGENT_OBSERVABILITY_HOME/copilot-cloud when the env var is set', () => {
    const env: ArchiveEnv = {
      homedir: () => '/home/ignored',
      env: { AGENT_OBSERVABILITY_HOME: '/base' },
    };
    expect(resolveCloudSinkDir(env)).toBe(path.join('/base', 'copilot-cloud'));
  });

  it('falls back to homedir/.agent-observability/copilot-cloud with no env var', () => {
    const env: ArchiveEnv = { homedir: () => '/home/u', env: {} };
    expect(resolveCloudSinkDir(env)).toBe(
      path.join('/home/u', ARCHIVE_DIR_NAME, 'copilot-cloud'),
    );
  });

  it('treats an empty env var as unset and falls back to homedir', () => {
    const env: ArchiveEnv = {
      homedir: () => '/home/u',
      env: { AGENT_OBSERVABILITY_HOME: '' },
    };
    expect(resolveCloudSinkDir(env)).toBe(
      path.join('/home/u', ARCHIVE_DIR_NAME, 'copilot-cloud'),
    );
  });

  it('returns undefined when there is neither an env var nor a home directory', () => {
    const env: ArchiveEnv = { homedir: () => '', env: {} };
    expect(resolveCloudSinkDir(env)).toBeUndefined();
  });
});

describe('CloudSink directory tree', () => {
  it('ensureDirs creates tasks/ and logs/', () => {
    const { sink, dir } = freshSink();
    sink.ensureDirs();
    expect(existsSync(path.join(dir, 'tasks'))).toBe(true);
    expect(existsSync(path.join(dir, 'logs'))).toBe(true);
  });

  it('exposes its root, index and lock paths', () => {
    const { sink, dir } = freshSink();
    expect(sink.dir()).toBe(dir);
    expect(sink.indexPath()).toBe(path.join(dir, 'index.json'));
    expect(sink.lockPath()).toBe(path.join(dir, 'writer.lock'));
  });
});

describe('CloudSink raw task payloads & session logs', () => {
  it('round-trips a raw task payload', () => {
    const { sink } = freshSink();
    const json = JSON.stringify({ id: 't1', state: 'completed' });
    sink.writeTaskRaw('t1', json);
    expect(sink.readTaskRaw('t1')).toBe(json);
  });

  it('returns undefined when reading a missing task payload', () => {
    const { sink } = freshSink();
    expect(sink.readTaskRaw('nope')).toBeUndefined();
  });

  it('round-trips a session SSE log and reports its presence', () => {
    const { sink } = freshSink();
    const sse = 'data: {"choices":[]}\n\n';
    expect(sink.hasSessionLog('s1')).toBe(false);
    sink.writeSessionLog('s1', sse);
    expect(sink.readSessionLog('s1')).toBe(sse);
    expect(sink.hasSessionLog('s1')).toBe(true);
  });

  it('returns undefined/false for a missing session log', () => {
    const { sink } = freshSink();
    expect(sink.readSessionLog('missing')).toBeUndefined();
    expect(sink.hasSessionLog('missing')).toBe(false);
  });
});

describe('CloudSink repo cache', () => {
  it('round-trips the repo cache', () => {
    const { sink } = freshSink();
    const refs: CloudRepoRef[] = [
      { id: 1, owner: 'o', name: 'r' },
      { id: 2, owner: 'p', name: 's' },
    ];
    sink.writeRepos(refs);
    expect(sink.readRepos()).toEqual(refs);
  });

  it('returns [] when the cache does not exist yet', () => {
    const { sink } = freshSink();
    expect(sink.readRepos()).toEqual([]);
  });

  it('returns [] for a corrupt repos.json', () => {
    const { sink, dir } = freshSink();
    writeFileSync(path.join(dir, 'repos.json'), 'not json{', 'utf8');
    expect(sink.readRepos()).toEqual([]);
  });

  it('returns [] when repos.json is valid JSON but not an array', () => {
    const { sink, dir } = freshSink();
    writeFileSync(path.join(dir, 'repos.json'), JSON.stringify({ id: 1 }), 'utf8');
    expect(sink.readRepos()).toEqual([]);
  });

  it('filters out malformed entries in a repos.json array', () => {
    const { sink, dir } = freshSink();
    const mixed = [
      { id: 1, owner: 'o', name: 'r' },
      { id: 'nope', owner: 'x', name: 'y' }, // id not a number
      { owner: 'p', name: 's' }, // missing id
      { id: 3, owner: 'q', name: 't' },
    ];
    writeFileSync(path.join(dir, 'repos.json'), JSON.stringify(mixed), 'utf8');
    expect(sink.readRepos()).toEqual([
      { id: 1, owner: 'o', name: 'r' },
      { id: 3, owner: 'q', name: 't' },
    ]);
  });
});

describe('CloudSink versioned index', () => {
  it('freshIndex is empty at the current schema/parser versions', () => {
    const idx = freshIndex();
    expect(idx.version).toBe(CLOUD_SINK_INDEX_VERSION);
    expect(idx.parserVersion).toBe(CLOUD_PARSER_VERSION);
    expect(idx.watermarkMs).toBe(0);
    expect(idx.tasks).toEqual({});
    expect(idx.poller).toEqual({ lastPollAtMs: 0, firstPollCompleted: false, accounts: [] });
  });

  it('readIndex on a fresh dir returns a fresh index', () => {
    const { sink } = freshSink();
    expect(sink.readIndex()).toEqual(freshIndex());
  });

  it('round-trips a written index', () => {
    const { sink } = freshSink();
    const index: SinkIndex = {
      version: CLOUD_SINK_INDEX_VERSION,
      parserVersion: CLOUD_PARSER_VERSION,
      watermarkMs: 12345,
      poller: {
        lastPollAtMs: 999,
        firstPollCompleted: true,
        accounts: [{ login: 'a', lastOutcome: 'ok', authSource: 'gh' }],
      },
      tasks: { t1: mkEntry('t1', 500, ['s1']) },
    };
    sink.writeIndex(index);
    expect(sink.readIndex()).toEqual(index);
  });

  it('invalidates the derived cache on a parserVersion bump while keeping raw files', () => {
    const { sink } = freshSink();
    const taskJson = JSON.stringify({ id: 't1' });
    const sse = 'data: {}\n\n';
    sink.writeTaskRaw('t1', taskJson);
    sink.writeSessionLog('s1', sse);

    // An index persisted by a newer parser version.
    const bumped: SinkIndex = {
      ...freshIndex(),
      parserVersion: CLOUD_PARSER_VERSION + 1,
      watermarkMs: 777,
      tasks: { t1: mkEntry('t1', 500, ['s1']) },
    };
    sink.writeIndex(bumped);

    // Derived cache is dropped...
    expect(sink.readIndex()).toEqual(freshIndex());
    // ...but the raw files remain on disk for re-parsing.
    expect(sink.readTaskRaw('t1')).toBe(taskJson);
    expect(sink.readSessionLog('s1')).toBe(sse);
    expect(sink.hasSessionLog('s1')).toBe(true);
  });

  it('invalidates the derived cache on an index version bump', () => {
    const { sink } = freshSink();
    const bumped: SinkIndex = {
      ...freshIndex(),
      version: CLOUD_SINK_INDEX_VERSION + 1,
      tasks: { t1: mkEntry('t1', 500, ['s1']) },
    };
    sink.writeIndex(bumped);
    expect(sink.readIndex()).toEqual(freshIndex());
  });

  it('returns a fresh index for a corrupt index.json', () => {
    const { sink, dir } = freshSink();
    writeFileSync(path.join(dir, 'index.json'), '{ not valid', 'utf8');
    expect(sink.readIndex()).toEqual(freshIndex());
  });

  it('indexMtimeMs is 0 before any write and positive after writeIndex', () => {
    const { sink } = freshSink();
    expect(sink.indexMtimeMs()).toBe(0);
    sink.writeIndex(freshIndex());
    expect(sink.indexMtimeMs()).toBeGreaterThan(0);
  });
});

describe('CloudSink listTaskEntries', () => {
  it('returns entries newest-first by updatedAtMs', () => {
    const { sink } = freshSink();
    const index: SinkIndex = {
      ...freshIndex(),
      tasks: {
        a: mkEntry('a', 100, ['sa']),
        b: mkEntry('b', 300, ['sb']),
        c: mkEntry('c', 200, ['sc']),
      },
    };
    sink.writeIndex(index);
    expect(sink.listTaskEntries().map((e) => e.taskId)).toEqual(['b', 'c', 'a']);
  });

  it('returns [] for a fresh dir', () => {
    const { sink } = freshSink();
    expect(sink.listTaskEntries()).toEqual([]);
  });
});

describe('CloudSink prune', () => {
  it('removes entries older than the retention window and deletes their raw files', () => {
    const { sink } = freshSink();
    const nowMs = 1_000_000;
    const retentionMs = 100_000; // cutoff = 900_000

    const index: SinkIndex = {
      ...freshIndex(),
      tasks: {
        old: mkEntry('old', 800_000, ['old-s1', 'old-s2']), // < cutoff → pruned
        fresh: mkEntry('fresh', 950_000, ['fresh-s1']), // >= cutoff → kept
      },
    };
    sink.writeIndex(index);
    sink.writeTaskRaw('old', '{"id":"old"}');
    sink.writeTaskRaw('fresh', '{"id":"fresh"}');
    sink.writeSessionLog('old-s1', 'a');
    sink.writeSessionLog('old-s2', 'b');
    sink.writeSessionLog('fresh-s1', 'c');

    const pruned = sink.prune(retentionMs, nowMs);
    expect(pruned).toBe(1);

    // Index no longer references the old task, still has the fresh one.
    const after = sink.readIndex();
    expect(Object.keys(after.tasks)).toEqual(['fresh']);

    // Old raw task + all its session logs are gone.
    expect(sink.readTaskRaw('old')).toBeUndefined();
    expect(sink.hasSessionLog('old-s1')).toBe(false);
    expect(sink.hasSessionLog('old-s2')).toBe(false);

    // Fresh raw files are untouched.
    expect(sink.readTaskRaw('fresh')).toBe('{"id":"fresh"}');
    expect(sink.hasSessionLog('fresh-s1')).toBe(true);
  });

  it('keeps an entry exactly at the retention boundary and returns 0', () => {
    const { sink } = freshSink();
    const nowMs = 1_000_000;
    const retentionMs = 100_000; // cutoff = 900_000
    const index: SinkIndex = {
      ...freshIndex(),
      tasks: { edge: mkEntry('edge', 900_000, ['e1']) }, // == cutoff → kept
    };
    sink.writeIndex(index);
    sink.writeTaskRaw('edge', '{}');
    sink.writeSessionLog('e1', 'x');

    const pruned = sink.prune(retentionMs, nowMs);
    expect(pruned).toBe(0);
    expect(Object.keys(sink.readIndex().tasks)).toEqual(['edge']);
    expect(sink.readTaskRaw('edge')).toBe('{}');
    expect(sink.hasSessionLog('e1')).toBe(true);
  });

  it('returns 0 on an empty index', () => {
    const { sink } = freshSink();
    expect(sink.prune(100_000, 1_000_000)).toBe(0);
  });
});
