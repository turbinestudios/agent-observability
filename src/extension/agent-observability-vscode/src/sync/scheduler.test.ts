import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SyncScheduler, SchedulerConfig, SchedulableEngine } from './scheduler';

/**
 * Scheduler tests with fake timers. These pin: OFF by default (no runs), enabled
 * -> runs on each tick, dispose stops the timer, and reschedule re-arms after a
 * config change. The gate-closed no-op is the engine's job; here we verify the
 * scheduler simply drives the engine and never crashes on a tick error.
 */

class FakeConfig implements SchedulerConfig {
  constructor(public enabled: boolean, public minutes: number) {}
  isSyncEnabled(): boolean {
    return this.enabled;
  }
  getSyncIntervalMinutes(): number {
    return this.minutes;
  }
}

class CountingEngine implements SchedulableEngine {
  runs = 0;
  throwOnRun = false;
  async runSync(): Promise<unknown> {
    this.runs += 1;
    if (this.throwOnRun) {
      throw new Error('boom');
    }
    return { status: 'upToDate' };
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('SyncScheduler', () => {
  it('does not run when sync is disabled (off by default)', () => {
    const config = new FakeConfig(false, 5);
    const engine = new CountingEngine();
    const scheduler = new SyncScheduler(config, engine);
    scheduler.start();

    vi.advanceTimersByTime(60 * 60 * 1000); // an hour
    expect(engine.runs).toBe(0);
    scheduler.dispose();
  });

  it('runs the engine on each interval tick when enabled', async () => {
    const config = new FakeConfig(true, 5); // every 5 minutes
    const engine = new CountingEngine();
    const scheduler = new SyncScheduler(config, engine);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(engine.runs).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(engine.runs).toBe(2);
    scheduler.dispose();
  });

  it('fires the onRun hook after each tick', async () => {
    const config = new FakeConfig(true, 5);
    const engine = new CountingEngine();
    const onRun = vi.fn();
    const scheduler = new SyncScheduler(config, engine, onRun);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(onRun).toHaveBeenCalledTimes(1);
    scheduler.dispose();
  });

  it('does not crash the timer when a tick throws (keeps ticking)', async () => {
    const config = new FakeConfig(true, 5);
    const engine = new CountingEngine();
    engine.throwOnRun = true;
    const scheduler = new SyncScheduler(config, engine);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(engine.runs).toBe(2); // still ticking despite throws
    scheduler.dispose();
  });

  it('dispose stops the timer (no further runs)', async () => {
    const config = new FakeConfig(true, 5);
    const engine = new CountingEngine();
    const scheduler = new SyncScheduler(config, engine);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(engine.runs).toBe(1);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(engine.runs).toBe(1); // unchanged after dispose
  });

  it('reschedule re-arms after enabling, and stops after disabling', async () => {
    const config = new FakeConfig(false, 5);
    const engine = new CountingEngine();
    const scheduler = new SyncScheduler(config, engine);
    scheduler.start();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(engine.runs).toBe(0); // disabled, nothing

    // Enable + reschedule -> ticks now run.
    config.enabled = true;
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(engine.runs).toBe(1);

    // Disable + reschedule -> timer cleared, no more runs.
    config.enabled = false;
    scheduler.reschedule();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(engine.runs).toBe(1);
    scheduler.dispose();
  });

  it('clamps a below-minimum interval to 5 minutes', async () => {
    const config = new FakeConfig(true, 1); // 1 < min 5; clamped to 5
    const engine = new CountingEngine();
    const scheduler = new SyncScheduler(config, engine);
    scheduler.start();

    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(engine.runs).toBe(0); // not yet at 5 min
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(engine.runs).toBe(1); // fired at 5 min
    scheduler.dispose();
  });
});
