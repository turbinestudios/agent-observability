import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EXPORT_FIRST_DELAY_MS, EXPORT_INTERVAL_MS, ExportScheduler } from './exportScheduler';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ExportScheduler', () => {
  it('runs once after the first delay, then on the interval, while enabled', () => {
    let runs = 0;
    const scheduler = new ExportScheduler({ enabled: () => true, run: () => void (runs += 1) });
    scheduler.arm();
    vi.advanceTimersByTime(EXPORT_FIRST_DELAY_MS - 1);
    expect(runs).toBe(0);
    vi.advanceTimersByTime(1);
    expect(runs).toBe(1);
    vi.advanceTimersByTime(EXPORT_INTERVAL_MS * 2);
    expect(runs).toBe(3);
    scheduler.disarm();
    vi.advanceTimersByTime(EXPORT_INTERVAL_MS * 2);
    expect(runs).toBe(3);
  });

  it('stays disarmed when sharing is off and re-arms on a settings change', () => {
    let enabled = false;
    let runs = 0;
    const scheduler = new ExportScheduler({ enabled: () => enabled, run: () => void (runs += 1) });
    scheduler.arm();
    expect(scheduler.armed()).toBe(false);
    enabled = true;
    scheduler.arm();
    expect(scheduler.armed()).toBe(true);
    vi.advanceTimersByTime(EXPORT_FIRST_DELAY_MS);
    expect(runs).toBe(1);
  });

  it('stops itself when sharing is turned off between ticks', () => {
    let enabled = true;
    let runs = 0;
    const scheduler = new ExportScheduler({ enabled: () => enabled, run: () => void (runs += 1) });
    scheduler.arm();
    vi.advanceTimersByTime(EXPORT_FIRST_DELAY_MS);
    enabled = false;
    vi.advanceTimersByTime(EXPORT_INTERVAL_MS);
    expect(runs).toBe(1);
    expect(scheduler.armed()).toBe(false);
  });

  it('survives a throwing run', () => {
    const scheduler = new ExportScheduler({
      enabled: () => true,
      run: () => {
        throw new Error('disk full');
      },
    });
    scheduler.arm();
    expect(() => vi.advanceTimersByTime(EXPORT_FIRST_DELAY_MS)).not.toThrow();
    expect(scheduler.armed()).toBe(true);
  });
});
