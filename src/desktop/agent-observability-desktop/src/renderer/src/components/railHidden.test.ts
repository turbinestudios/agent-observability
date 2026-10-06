import { describe, expect, it } from 'vitest';
import { hiddenRailEntries } from './railHidden';

describe('hiddenRailEntries', () => {
  it('hides Run and Team until each is turned on', () => {
    expect(hiddenRailEntries({ run: false, team: false })).toEqual(['run', 'team']);
    expect(hiddenRailEntries({ run: true, team: false })).toEqual(['team']);
    expect(hiddenRailEntries({ run: false, team: true })).toEqual(['run']);
    expect(hiddenRailEntries({ run: true, team: true })).toEqual([]);
  });
});
