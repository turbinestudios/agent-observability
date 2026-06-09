import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createCoalescer,
  isRelevantChange,
  sourceSignature,
  watchTelemetrySource,
} from './sourceWatcher';
import { PathConfig } from './paths';

/**
 * The live-update watcher. The pure relevance filter and the size/mtime
 * fingerprint are covered directly; the coalescer timing is driven with fake
 * timers; the polling detection path is exercised against real temp files. The
 * raw `fs.watch` event timing remains platform-dependent and is NOT asserted
 * (indeed, on Windows it does not fire for held-open WAL appends — which is the
 * whole reason the poll exists).
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

describe('createCoalescer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces a sporadic burst into one fire after the quiet period', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const c = createCoalescer(fire, 750, 1500);

    // Three changes within the debounce window — should collapse to one fire.
    c.schedule();
    vi.advanceTimersByTime(200);
    c.schedule();
    vi.advanceTimersByTime(200);
    c.schedule();
    expect(fire).not.toHaveBeenCalled();

    vi.advanceTimersByTime(750);
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('fires mid-stream via the max-wait cap when writes never go quiet', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const c = createCoalescer(fire, 750, 1500);

    // Continuous writes every 300ms keep resetting the 750ms trailing timer, so
    // a pure debounce would never fire. The 1500ms cap must still fire.
    for (let t = 0; t < 1500; t += 300) {
      c.schedule();
      vi.advanceTimersByTime(300);
    }
    expect(fire).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh cycle after a cap-driven fire', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const c = createCoalescer(fire, 750, 1500);

    for (let t = 0; t < 1500; t += 300) {
      c.schedule();
      vi.advanceTimersByTime(300);
    }
    expect(fire).toHaveBeenCalledTimes(1);

    // A second continuous burst gets its own cap-driven fire.
    for (let t = 0; t < 1500; t += 300) {
      c.schedule();
      vi.advanceTimersByTime(300);
    }
    expect(fire).toHaveBeenCalledTimes(2);
  });

  it('does not fire after cancel', () => {
    vi.useFakeTimers();
    const fire = vi.fn();
    const c = createCoalescer(fire, 750, 1500);

    c.schedule();
    c.cancel();
    vi.advanceTimersByTime(5000);
    expect(fire).not.toHaveBeenCalled();

    // Post-cancel schedules are inert.
    c.schedule();
    vi.advanceTimersByTime(5000);
    expect(fire).not.toHaveBeenCalled();
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

  it('tolerates an override pointing at a missing directory (poller waits, no early fire)', () => {
    const config: PathConfig = {
      getSqlitePathOverride: () => '/nonexistent-dir-xyz/agent-traces.db',
    };
    const onChange = vi.fn();
    // The directory can't be fs.watch'd yet, but the poller arms harmlessly and
    // simply observes "absent" until a DB appears — no synchronous fire, clean dispose.
    const handle = watchTelemetrySource(config, onChange);
    watchers.push(handle);
    expect(() => handle.dispose()).not.toThrow();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('fires via the poller when the -wal grows (the fs.watch-blind case on Windows)', () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-poll-'));
    const dbPath = path.join(dir, 'agent-traces.db');
    const walPath = `${dbPath}-wal`;
    fs.writeFileSync(dbPath, Buffer.alloc(4096));
    fs.writeFileSync(walPath, Buffer.alloc(32));

    const onChange = vi.fn();
    const handle = watchTelemetrySource(
      { getSqlitePathOverride: () => dbPath },
      onChange,
      { pollIntervalMs: 100, debounceMs: 50, maxWaitMs: 200 },
    );

    try {
      // Simulate a committed-span append to the held-open WAL.
      fs.appendFileSync(walPath, Buffer.alloc(4120));
      // One poll tick observes the size change, then the coalescer fires.
      vi.advanceTimersByTime(100); // poll detects change → schedule()
      vi.advanceTimersByTime(200); // debounce/maxWait elapses → fire
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally {
      handle.dispose();
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not fire when the source is idle (no pointless re-snapshots)', () => {
    vi.useFakeTimers();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-idle-'));
    const dbPath = path.join(dir, 'agent-traces.db');
    fs.writeFileSync(dbPath, Buffer.alloc(4096));

    const onChange = vi.fn();
    const handle = watchTelemetrySource(
      { getSqlitePathOverride: () => dbPath },
      onChange,
      { pollIntervalMs: 100, debounceMs: 50, maxWaitMs: 200 },
    );

    try {
      vi.advanceTimersByTime(1000); // many poll ticks, nothing changed
      expect(onChange).not.toHaveBeenCalled();
    } finally {
      handle.dispose();
      vi.useRealTimers();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('sourceSignature', () => {
  let dir: string;
  afterEach(() => {
    if (dir !== undefined) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('changes when the -wal grows and marks missing files with a sentinel', () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sw-sig-'));
    const dbPath = path.join(dir, 'agent-traces.db');
    fs.writeFileSync(dbPath, Buffer.alloc(4096));

    // No WAL yet → the sidecar slot is the '-' sentinel.
    const noWal = sourceSignature(dbPath);
    expect(noWal).toContain('-');

    fs.writeFileSync(`${dbPath}-wal`, Buffer.alloc(32));
    const withWal = sourceSignature(dbPath);
    expect(withWal).not.toBe(noWal);

    // Appending to the WAL (the held-open case) changes the fingerprint.
    fs.appendFileSync(`${dbPath}-wal`, Buffer.alloc(4120));
    expect(sourceSignature(dbPath)).not.toBe(withWal);
  });
});
