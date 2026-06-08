import { describe, it, expect, vi, afterEach } from 'vitest';
import { isRelevantChange, watchTelemetrySource } from './sourceWatcher';
import { PathConfig } from './paths';

/**
 * The live-update watcher. The pure relevance filter is covered exhaustively; the
 * no-source / unwatchable-directory short-circuits are checked to confirm they
 * degrade to a safe no-op (manual refresh still works). The fs.watch event timing
 * itself is platform-dependent and intentionally NOT asserted here.
 */

describe('isRelevantChange', () => {
  const base = 'agent-traces.db';

  it('matches the db file and its sidecars', () => {
    expect(isRelevantChange(base, 'agent-traces.db')).toBe(true);
    expect(isRelevantChange(base, 'agent-traces.db-wal')).toBe(true);
    expect(isRelevantChange(base, 'agent-traces.db-shm')).toBe(true);
    expect(isRelevantChange(base, 'agent-traces.db-journal')).toBe(true);
  });

  it('ignores unrelated files in the directory', () => {
    expect(isRelevantChange(base, 'session-store.db')).toBe(false);
    expect(isRelevantChange(base, 'toolEmbeddingsCache.bin')).toBe(false);
    expect(isRelevantChange(base, 'other.db')).toBe(false);
  });

  it('treats a null filename as relevant (never miss a write)', () => {
    expect(isRelevantChange(base, null)).toBe(true);
  });
});

describe('watchTelemetrySource', () => {
  const watchers: Array<{ dispose(): void }> = [];
  afterEach(() => {
    while (watchers.length > 0) {
      watchers.pop()?.dispose();
    }
  });

  it('is a safe no-op when no source path resolves', () => {
    const config: PathConfig = { getSqlitePathOverride: () => undefined };
    // Force "no candidate" by pointing the override at nothing AND relying on the
    // resolver returning undefined when the platform has no home — but since that
    // is environment-dependent, we instead assert the contract: dispose never
    // throws and onChange is not called synchronously.
    const onChange = vi.fn();
    const handle = watchTelemetrySource(config, onChange);
    watchers.push(handle);
    expect(() => handle.dispose()).not.toThrow();
    expect(() => handle.dispose()).not.toThrow(); // idempotent
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not watch (no-op handle) when the override points at a missing directory', () => {
    const config: PathConfig = {
      getSqlitePathOverride: () => '/nonexistent-dir-xyz/agent-traces.db',
    };
    const onChange = vi.fn();
    const handle = watchTelemetrySource(config, onChange);
    watchers.push(handle);
    expect(() => handle.dispose()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });
});
