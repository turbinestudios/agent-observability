import { describe, it, expect } from 'vitest';
import { GlobalStateSyncStateStore } from './globalStateSyncStateStore';
import { SyncRun, MAX_HISTORY } from './syncState';

/**
 * The globalState-backed store, driven by a tiny fake Memento so no `vscode`
 * runtime is needed. Covers the same watermark and ring-buffer behaviors as the
 * in-memory store (see `syncState.test.ts`) against real persistence calls, plus
 * the storage-key contract — renaming a key would silently orphan a user's
 * watermark and replay an already-uploaded window.
 */

function run(n: number): SyncRun {
  return { startedAtMs: n, windowStartMs: n, windowEndMs: n + 1, bucketsSent: n, outcome: 'success' };
}

/** Minimal in-memory Memento satisfying the GlobalStateSyncStateStore needs. */
class FakeMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return this.store.has(key) ? (this.store.get(key) as T) : (defaultValue as T);
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

function makeStore(): GlobalStateSyncStateStore {
  return new GlobalStateSyncStateStore(new FakeMemento() as never);
}

describe('GlobalStateSyncStateStore', () => {
  it('round-trips the watermark', async () => {
    const store = makeStore();
    expect(store.getWatermarkMs()).toBeUndefined();
    await store.setWatermarkMs(1234);
    expect(store.getWatermarkMs()).toBe(1234);
  });

  it('clears the watermark back to undefined', async () => {
    const store = makeStore();
    await store.setWatermarkMs(1234);
    await store.clearWatermark();
    expect(store.getWatermarkMs()).toBeUndefined();
  });

  it('ignores a non-numeric stored watermark', () => {
    const memento = new FakeMemento();
    void memento.update(GlobalStateSyncStateStore.WATERMARK_KEY, 'not-a-number');
    const store = new GlobalStateSyncStateStore(memento as never);
    expect(store.getWatermarkMs()).toBeUndefined();
  });

  it('returns history most-recent-first', async () => {
    const store = makeStore();
    await store.recordRun(run(1));
    await store.recordRun(run(2));
    await store.recordRun(run(3));
    expect(store.getHistory().map((r) => r.startedAtMs)).toEqual([3, 2, 1]);
  });

  it(`caps the ring buffer at ${MAX_HISTORY} entries, evicting the oldest`, async () => {
    const store = makeStore();
    for (let i = 1; i <= MAX_HISTORY + 5; i += 1) {
      await store.recordRun(run(i));
    }
    const history = store.getHistory();
    expect(history).toHaveLength(MAX_HISTORY);
    // Most recent first; oldest retained is (total - MAX_HISTORY + 1) = 6.
    expect(history[0].startedAtMs).toBe(MAX_HISTORY + 5);
    expect(history[history.length - 1].startedAtMs).toBe(6);
  });
});

describe('GlobalStateSyncStateStore key contract', () => {
  it('uses the documented watermark key', () => {
    expect(GlobalStateSyncStateStore.WATERMARK_KEY).toBe('agentObservability.sync.lastWindowEndMs');
  });

  it('uses the documented history key', () => {
    expect(GlobalStateSyncStateStore.HISTORY_KEY).toBe('agentObservability.sync.runHistory');
  });
});
