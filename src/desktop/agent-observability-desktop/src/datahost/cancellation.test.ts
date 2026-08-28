import { describe, expect, it, vi } from 'vitest';
import { manualToken, timeoutToken } from './cancellation';

describe('manualToken', () => {
  it('starts uncancelled and fires listeners once on cancel', () => {
    const manual = manualToken();
    const heard: unknown[] = [];
    manual.token.onCancellationRequested((e) => heard.push(e));

    expect(manual.token.isCancellationRequested).toBe(false);
    manual.cancel();
    manual.cancel(); // idempotent — a second cancel must not re-fire
    expect(manual.token.isCancellationRequested).toBe(true);
    expect(heard).toHaveLength(1);
  });

  it('a disposed listener no longer hears the cancel', () => {
    const manual = manualToken();
    const heard: unknown[] = [];
    manual.token.onCancellationRequested((e) => heard.push(e)).dispose();
    manual.cancel();
    expect(heard).toHaveLength(0);
  });
});

describe('timeoutToken', () => {
  it('cancels itself after the timeout', () => {
    vi.useFakeTimers();
    try {
      const timeout = timeoutToken(1000);
      expect(timeout.token.isCancellationRequested).toBe(false);
      vi.advanceTimersByTime(1001);
      expect(timeout.token.isCancellationRequested).toBe(true);
      timeout.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dispose() before the deadline prevents the cancel', () => {
    vi.useFakeTimers();
    try {
      const timeout = timeoutToken(1000);
      timeout.dispose();
      vi.advanceTimersByTime(2000);
      expect(timeout.token.isCancellationRequested).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
