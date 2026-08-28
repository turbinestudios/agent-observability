import { describe, it, expect } from 'vitest';
import { chooseCostBasis } from './costBasis';

/**
 * A combined view shows one cost tile, so a selection spanning sources has to
 * pick a basis and admit what the resulting figure leaves out.
 */

const claude = { costMode: 'usd' as const, label: 'Claude Code', startedAtMs: 2_000 };
const copilot = { costMode: 'aiu' as const, label: 'Copilot', startedAtMs: 1_000 };

describe('chooseCostBasis', () => {
  it('says nothing when every session bills the same way', () => {
    const basis = chooseCostBasis([claude, { ...claude, startedAtMs: 3_000 }]);

    expect(basis.costMode).toBe('usd');
    expect(basis.note).toBeUndefined();
  });

  it('picks the basis held by the most sessions', () => {
    const basis = chooseCostBasis([copilot, claude, { ...claude, startedAtMs: 4_000 }]);

    expect(basis.costMode).toBe('usd');
  });

  it('breaks a tie with the earliest session, so the same selection is stable', () => {
    const forwards = chooseCostBasis([claude, copilot]);
    const backwards = chooseCostBasis([copilot, claude]);

    // Copilot started first, so its basis wins both orderings.
    expect(forwards.costMode).toBe('aiu');
    expect(backwards.costMode).toBe('aiu');
  });

  it('names the chosen basis and what its figure excludes', () => {
    const basis = chooseCostBasis([claude, copilot]);

    expect(basis.note).toContain('AIU');
    expect(basis.note).toContain('Copilot');
    expect(basis.note).toContain('Claude Code');
    expect(basis.note).toContain('not towards the cost');
  });

  it('falls back to a basis rather than throwing on an empty selection', () => {
    expect(chooseCostBasis([]).costMode).toBe('aiu');
  });
});
