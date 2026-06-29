import { describe, it, expect } from 'vitest';
import { LiveUpdateController } from './liveUpdateController';
import { LiveSource } from './liveSource';

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A LiveSource that records lifecycle calls and exposes its controller signal. */
function fakeSource(label: string, log: string[], onStart?: () => void): LiveSource {
  return {
    label,
    start: () => {
      log.push(`start:${label}`);
      onStart?.();
    },
    stop: () => log.push(`stop:${label}`),
  };
}

describe('LiveUpdateController', () => {
  it('coalesces a burst of signals into one debounced refresh', async () => {
    let refreshes = 0;
    const controller = new LiveUpdateController({ onRefresh: () => (refreshes += 1), debounceMs: 15 });
    await controller.start();

    controller.signal();
    controller.signal();
    controller.signal();
    expect(refreshes).toBe(0); // still within the window

    await delay(40);
    expect(refreshes).toBe(1); // the burst collapsed to a single refresh

    controller.signal();
    await delay(40);
    expect(refreshes).toBe(2); // a later signal opens a new window

    controller.stop();
  });

  it('ignores signals before start and after stop', async () => {
    let refreshes = 0;
    const controller = new LiveUpdateController({ onRefresh: () => (refreshes += 1), debounceMs: 10 });

    controller.signal(); // before start → ignored
    await delay(25);
    expect(refreshes).toBe(0);

    await controller.start();
    controller.stop();
    controller.signal(); // after stop → ignored
    await delay(25);
    expect(refreshes).toBe(0);
  });

  it('starts and stops every registered source', async () => {
    const log: string[] = [];
    const controller = new LiveUpdateController({ onRefresh: () => {}, debounceMs: 10 });
    controller.register(fakeSource('a', log));
    controller.register(fakeSource('b', log));
    expect(controller.sourceCount).toBe(2);

    await controller.start();
    controller.stop();

    expect(log).toEqual(['start:a', 'start:b', 'stop:a', 'stop:b']);
    expect(controller.sourceCount).toBe(0); // sources cleared on stop
  });

  it('reports a source that throws on start and still starts the others', async () => {
    const log: string[] = [];
    const errors: unknown[] = [];
    const controller = new LiveUpdateController({
      onRefresh: () => {},
      debounceMs: 10,
      onError: (e) => errors.push(e),
    });
    controller.register(
      fakeSource('boom', log, () => {
        throw new Error('bind failed');
      }),
    );
    controller.register(fakeSource('ok', log));

    await controller.start();

    expect(errors).toHaveLength(1);
    expect(log).toContain('start:ok'); // the healthy source still started
    controller.stop();
  });

  it('cancels a pending refresh on stop', async () => {
    let refreshes = 0;
    const controller = new LiveUpdateController({ onRefresh: () => (refreshes += 1), debounceMs: 30 });
    await controller.start();
    controller.signal();
    controller.stop(); // before the window elapses
    await delay(50);
    expect(refreshes).toBe(0);
  });
});
