import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, utimesSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ARCHIVE_DIR_NAME, ArchiveEnv } from '../otel/archivePaths';
import { AgentSink, freshAgentIndex, resolveAgentSinkDir } from './agentSink';
import { AgentSinkIndex } from './agentTypes';

const created: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-sink-'));
  created.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveAgentSinkDir', () => {
  it('uses AGENT_OBSERVABILITY_HOME/copilot-agent when the env var is set', () => {
    const env: ArchiveEnv = { homedir: () => '/home/u', env: { AGENT_OBSERVABILITY_HOME: '/base' } };
    expect(resolveAgentSinkDir(env)).toBe(path.join('/base', 'copilot-agent'));
  });

  it('falls back to homedir/.agent-observability/copilot-agent with no env var', () => {
    const env: ArchiveEnv = { homedir: () => '/home/u', env: {} };
    expect(resolveAgentSinkDir(env)).toBe(path.join('/home/u', ARCHIVE_DIR_NAME, 'copilot-agent'));
  });

  it('returns undefined when there is no home and no env override', () => {
    const env: ArchiveEnv = { homedir: () => '', env: {} };
    expect(resolveAgentSinkDir(env)).toBeUndefined();
  });
});

describe('AgentSink raw batches', () => {
  it('round-trips a raw batch partitioned by service', () => {
    const sink = new AgentSink(tempDir());
    expect(sink.hasBatchRaw('error-remediation', 'b1')).toBe(false);
    sink.writeBatchRaw('error-remediation', 'b1', '{"resourceSpans":[]}');
    expect(sink.hasBatchRaw('error-remediation', 'b1')).toBe(true);
    expect(sink.readBatchRaw('error-remediation', 'b1')).toBe('{"resourceSpans":[]}');
    // A different service does not collide.
    expect(sink.hasBatchRaw('dependency-updater', 'b1')).toBe(false);
  });

  it('exposes ingest.db beside the index and lock', () => {
    const root = tempDir();
    const sink = new AgentSink(root);
    expect(sink.ingestDbPath()).toBe(path.join(root, 'ingest.db'));
    expect(sink.indexPath()).toBe(path.join(root, 'index.json'));
    expect(sink.lockPath()).toBe(path.join(root, 'writer.lock'));
  });
});

describe('AgentSink index', () => {
  it('returns a fresh index when none exists', () => {
    const sink = new AgentSink(tempDir());
    expect(sink.readIndex()).toEqual(freshAgentIndex());
  });

  it('round-trips a written index', () => {
    const sink = new AgentSink(tempDir());
    const index = freshAgentIndex();
    index.watermarkMs = 1234;
    index.batches['b1'] = { batchId: 'b1', service: 'svc', createdAtMs: 1234, ingestedAtMs: 2000, spanCount: 3 };
    sink.writeIndex(index);
    expect(sink.readIndex()).toEqual(index);
  });

  it('discards an index written at a different version', () => {
    const root = tempDir();
    const sink = new AgentSink(root);
    sink.ensureDirs();
    const stale = { ...freshAgentIndex(), version: 999, watermarkMs: 55 } as AgentSinkIndex;
    writeFileSync(sink.indexPath(), JSON.stringify(stale), 'utf8');
    expect(sink.readIndex()).toEqual(freshAgentIndex());
  });

  it('lists batch entries newest-first', () => {
    const sink = new AgentSink(tempDir());
    const index = freshAgentIndex();
    index.batches['a'] = { batchId: 'a', service: 's', createdAtMs: 100, ingestedAtMs: 100, spanCount: 1 };
    index.batches['b'] = { batchId: 'b', service: 's', createdAtMs: 300, ingestedAtMs: 300, spanCount: 1 };
    index.batches['c'] = { batchId: 'c', service: 's', createdAtMs: 200, ingestedAtMs: 200, spanCount: 1 };
    sink.writeIndex(index);
    expect(sink.listBatchEntries().map((e) => e.batchId)).toEqual(['b', 'c', 'a']);
  });
});

describe('AgentSink.pruneRaw', () => {
  it('removes index entries + raw files older than retention, keeping newer', () => {
    const sink = new AgentSink(tempDir());
    sink.writeBatchRaw('svc', 'old', '{}');
    sink.writeBatchRaw('svc', 'new', '{}');
    const index = freshAgentIndex();
    index.batches['old'] = { batchId: 'old', service: 'svc', createdAtMs: 1_000, ingestedAtMs: 1_000, spanCount: 1 };
    index.batches['new'] = { batchId: 'new', service: 'svc', createdAtMs: 9_000, ingestedAtMs: 9_000, spanCount: 1 };
    sink.writeIndex(index);

    // now=10_000, retention=2_000 → cutoff 8_000: 'old' (1_000) prunes, 'new' (9_000) stays.
    const pruned = sink.pruneRaw(2_000, 10_000);
    expect(pruned).toBe(1);
    expect(sink.readIndex().batches).toHaveProperty('new');
    expect(sink.readIndex().batches).not.toHaveProperty('old');
    expect(sink.hasBatchRaw('svc', 'old')).toBe(false);
    expect(sink.hasBatchRaw('svc', 'new')).toBe(true);
  });

  it('sweeps orphaned raw files older than the cutoff', () => {
    const sink = new AgentSink(tempDir());
    // An orphan raw file with no index entry, aged well before the cutoff.
    sink.writeBatchRaw('svc', 'orphan', '{}');
    const orphanPath = path.join(sink.dir(), 'raw', 'svc', 'orphan.json');
    const oldSecs = 1_000; // mtime → 1_000_000 ms, far older than the cutoff below
    utimesSync(orphanPath, oldSecs, oldSecs);
    expect(existsSync(orphanPath)).toBe(true);

    // cutoff = 10_000_000 − 2_000 = 9_998_000 ms; orphan (1_000_000 ms) is swept.
    sink.pruneRaw(2_000, 10_000_000);
    expect(existsSync(orphanPath)).toBe(false);
  });
});
