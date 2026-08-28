import { describe, expect, it } from 'vitest';
import { FUN_NOTES, rotatedNote } from './loadingNotes';

describe('rotatedNote', () => {
  const leads = ['Honest lead.', 'Second honest line.'];

  it('shows the honest leads first — a fast load never opens on a joke', () => {
    expect(rotatedNote(leads, 0)).toBe('Honest lead.');
    expect(rotatedNote(leads, 1)).toBe('Second honest line.');
  });

  it('drifts into the shared pool once the leads are spent, then wraps', () => {
    expect(FUN_NOTES).toContain(rotatedNote(leads, leads.length, 7));
    expect(rotatedNote(leads, leads.length + FUN_NOTES.length, 7)).toBe('Honest lead.');
  });

  it('plays every pool note exactly once per cycle, whatever the seed', () => {
    const seen = new Set<string>();
    for (let tick = leads.length; tick < leads.length + FUN_NOTES.length; tick++) {
      seen.add(rotatedNote(leads, tick, 1234));
    }
    expect(seen.size).toBe(FUN_NOTES.length);
  });

  it('shuffles the pool differently per seed, but repeatably within one', () => {
    const sequence = (seed: number): string[] =>
      Array.from({ length: FUN_NOTES.length }, (_, i) => rotatedNote(leads, leads.length + i, seed));
    expect(sequence(1)).toEqual(sequence(1));
    expect(sequence(1)).not.toEqual(sequence(2));
    // The leads never shuffle: a fast load must still open honestly.
    expect(rotatedNote(leads, 0, 1)).toBe('Honest lead.');
    expect(rotatedNote(leads, 0, 2)).toBe('Honest lead.');
  });

  it('the pool has variety and no accidental duplicates', () => {
    expect(FUN_NOTES.length).toBeGreaterThanOrEqual(20);
    expect(new Set(FUN_NOTES).size).toBe(FUN_NOTES.length);
  });
});
