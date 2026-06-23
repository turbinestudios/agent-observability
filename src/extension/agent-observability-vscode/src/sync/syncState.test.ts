import { describe, it, expect } from 'vitest';
import {
  InMemorySyncStateStore,
  GlobalStateSyncStateStore,
  SyncRun,
  MAX_HISTORY,
} from './syncState';

/**
 * State-store tests: watermark round-trip + the bounded, most-recent-first ring
 * buffer, for both the in-memory impl and the globalState-backed impl (driven by
 * a tiny fake Memento so no `vscode` runtime is needed).
 */

function run(n: number): SyncRun {
  return { startedAtMs: n, windowStartMs: n, windowEndMs: n + 1, bucketsSent: n, outcome: 'success' };
}

/** Minimal in-memory Memento satisfying the GlobalStateSyncStateStore needs. */
class FakeMemento {
  private store = new Map<string, unknown>();
  get<T>(key: string, defaultValue?: T): T {
    return (this.store.has(key) ? (this.store.get(key) as T) : (defaultValue as T));
  }
  async update(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  keys(): readonly string[] {
    return [...this.store.keys()];
  }
}

describe.each([
  ['InMemory', () => new InMemorySyncStateStore()],
  ['GlobalState', () => new GlobalStateSyncStateStore(new FakeMemento() as never)],
])('SyncStateStore (%s)', (_name, make) => {
  it('round-trips the watermark', async () => {
    const store = make();
    expect(store.getWatermarkMs()).toBeUndefined();
    await store.setWatermarkMs(1234);
    expect(store.getWatermarkMs()).toBe(1234);
  });

  it('returns history most-recent-first', async () => {
    const store = make();
    await store.recordRun(run(1));
    await store.recordRun(run(2));
    await store.recordRun(run(3));
    const history = store.getHistory();
    expect(history.map((r) => r.startedAtMs)).toEqual([3, 2, 1]);
  });

  it(`caps the ring buffer at ${MAX_HISTORY} entries, evicting the oldest`, async () => {
    const store = make();
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
});
