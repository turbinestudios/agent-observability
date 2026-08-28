import { describe, expect, it } from 'vitest';
import { showsVerdictChip, verdictLabel } from './retro';

describe('verdictLabel', () => {
  it('names every verdict in plain language', () => {
    expect(verdictLabel('smooth')).toBe('Went smoothly');
    expect(verdictLabel('bumpy')).toBe('Some friction');
    expect(verdictLabel('struggled')).toBe('Struggled');
    expect(verdictLabel('abandoned')).toBe('Left unfinished');
  });
});

describe('showsVerdictChip', () => {
  it('marks only the two worst tiers, so the list does not turn into confetti', () => {
    expect(showsVerdictChip('struggled')).toBe(true);
    expect(showsVerdictChip('abandoned')).toBe(true);
    expect(showsVerdictChip('bumpy')).toBe(false);
    expect(showsVerdictChip('smooth')).toBe(false);
  });

  it('an unjudged session shows nothing — absent is not smooth', () => {
    expect(showsVerdictChip(undefined)).toBe(false);
  });
});
