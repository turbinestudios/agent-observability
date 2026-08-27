import { describe, it, expect } from 'vitest';
import { InMemorySyncStateStore, SyncRun, MAX_HISTORY } from './syncState';

/**
 * State-store tests for the host-independent in-memory implementation: watermark
 * round-trip plus the bounded, most-recent-first ring buffer. Each host-backed
 * store covers the same behaviors against its own persistence — see
 * `globalStateSyncStateStore.test.ts` for the VS Code globalState one.
 */

function run(n: number): SyncRun {
  return { startedAtMs: n, windowStartMs: n, windowEndMs: n + 1, bucketsSent: n, outcome: 'success' };
}

describe('InMemorySyncStateStore', () => {
  it('round-trips the watermark', async () => {
    const store = new InMemorySyncStateStore();
    expect(store.getWatermarkMs()).toBeUndefined();
    await store.setWatermarkMs(1234);
    expect(store.getWatermarkMs()).toBe(1234);
  });

  it('clears the watermark back to undefined', async () => {
    const store = new InMemorySyncStateStore();
    await store.setWatermarkMs(1234);
    await store.clearWatermark();
    expect(store.getWatermarkMs()).toBeUndefined();
  });

  it('seeds an initial watermark when constructed with one', () => {
    expect(new InMemorySyncStateStore(99).getWatermarkMs()).toBe(99);
  });

  it('returns history most-recent-first', async () => {
    const store = new InMemorySyncStateStore();
    await store.recordRun(run(1));
    await store.recordRun(run(2));
    await store.recordRun(run(3));
    expect(store.getHistory().map((r) => r.startedAtMs)).toEqual([3, 2, 1]);
  });

  it(`caps the ring buffer at ${MAX_HISTORY} entries, evicting the oldest`, async () => {
    const store = new InMemorySyncStateStore();
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
