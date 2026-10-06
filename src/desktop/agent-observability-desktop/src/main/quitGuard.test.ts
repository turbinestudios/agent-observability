import { describe, expect, it } from 'vitest';
import { quitMessage, shouldConfirmQuit } from './quitGuard';

describe('quit guard', () => {
  it('asks only when sessions are running, and counts them in the message', () => {
    expect(shouldConfirmQuit(0)).toBe(false);
    expect(shouldConfirmQuit(Number.NaN)).toBe(false);
    expect(shouldConfirmQuit(2)).toBe(true);
    expect(quitMessage(1)).toContain('A session');
    expect(quitMessage(3)).toContain('3 sessions');
  });
});
