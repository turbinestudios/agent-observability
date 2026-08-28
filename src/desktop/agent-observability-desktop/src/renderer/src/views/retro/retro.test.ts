import { describe, expect, it } from 'vitest';
import type { RetroListRow } from '../../../../shared/rpc';
import { describeRetroCoverage, frictionSummary, verdictChipClass } from './retro';

function rowOf(overrides: Partial<RetroListRow> = {}): RetroListRow {
  return {
    source: 'claude',
    sessionId: 's1',
    repository: 'repo',
    endedAtMs: 0,
    verdict: 'bumpy',
    outcome: 'unclear',
    correctionTurns: 0,
    repeatedPromptTurns: 0,
    interruptions: 0,
    maxErrorStreak: 0,
    churnRatioPct: 0,
    compactions: 0,
    tipCount: 0,
    ...overrides,
  };
}

describe('frictionSummary', () => {
  it('names only the signals that actually fired', () => {
    expect(frictionSummary(rowOf({ correctionTurns: 2, maxErrorStreak: 4 }))).toBe(
      '2 corrections · worst error streak 4',
    );
  });

  it('says nothing for a session with no friction numbers', () => {
    expect(frictionSummary(rowOf())).toBe('');
  });

  it('uses singular forms for single occurrences', () => {
    expect(frictionSummary(rowOf({ interruptions: 1 }))).toBe('1 interruption');
  });
});

describe('verdictChipClass', () => {
  it('derives the modifier from the verdict', () => {
    expect(verdictChipClass('struggled')).toBe('retro-view-chip-struggled');
  });
});

describe('describeRetroCoverage', () => {
  it('states both the judged and the analyzed counts', () => {
    expect(
      describeRetroCoverage([rowOf(), rowOf()], { analyzed: 40, total: 80, running: true }),
    ).toBe('2 judged sessions, of the 40 sessions analyzed so far.');
  });

  it('says plainly when nothing has been judged yet', () => {
    expect(describeRetroCoverage([], { analyzed: 0, total: 10, running: true })).toBe(
      'No judged sessions yet.',
    );
  });
});
