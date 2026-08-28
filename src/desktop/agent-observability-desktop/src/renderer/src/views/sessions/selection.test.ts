import { describe, it, expect } from 'vitest';
import { compareState, toggleSelection } from './selection';
import { MAX_COMPARE_SESSIONS } from '../../../../shared/rpc';

const keys = (n: number): string[] => Array.from({ length: n }, (_, i) => `claude:s${i}`);

describe('toggleSelection', () => {
  it('adds a key that is not selected, keeping the ones already there', () => {
    expect(toggleSelection(['claude:a'], 'copilot:b')).toEqual(['claude:a', 'copilot:b']);
  });

  it('removes a key that is already selected', () => {
    expect(toggleSelection(['claude:a', 'copilot:b'], 'claude:a')).toEqual(['copilot:b']);
  });

  it('does not mutate the list it was given', () => {
    const before = ['claude:a'];
    toggleSelection(before, 'copilot:b');
    expect(before).toEqual(['claude:a']);
  });
});

describe('compareState', () => {
  it('needs a second session before comparing is possible', () => {
    expect(compareState([]).canCompare).toBe(false);
    expect(compareState(keys(1))).toMatchObject({ count: 1, canCompare: false });
    expect(compareState(keys(1)).reason).toContain('another session');
  });

  it('is live from two sessions up to the cap', () => {
    expect(compareState(keys(2))).toEqual({ count: 2, canCompare: true });
    expect(compareState(keys(MAX_COMPARE_SESSIONS)).canCompare).toBe(true);
  });

  it('says why past the cap, rather than letting the app stall on the parses', () => {
    const state = compareState(keys(MAX_COMPARE_SESSIONS + 1));

    expect(state.canCompare).toBe(false);
    expect(state.reason).toContain(String(MAX_COMPARE_SESSIONS));
  });
});
