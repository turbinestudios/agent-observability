import { describe, expect, it } from 'vitest';
import { railBadgeLabel, railBadgeText } from './railBadge';

describe('rail badge', () => {
  it('shows nothing for zero and caps above nine', () => {
    expect(railBadgeText(0)).toBeUndefined();
    expect(railBadgeText(undefined)).toBeUndefined();
    expect(railBadgeText(Number.NaN)).toBeUndefined();
    expect(railBadgeText(3)).toBe('3');
    expect(railBadgeText(9)).toBe('9');
    expect(railBadgeText(10)).toBe('9+');
  });

  it('extends the accessible name only when there is a count', () => {
    expect(railBadgeLabel('Workspace', 0)).toBe('Workspace');
    expect(railBadgeLabel('Workspace', 3)).toBe('Workspace, 3 new');
    expect(railBadgeLabel('Workspace', 12)).toBe('Workspace, 9+ new');
  });
});
