import { describe, expect, it } from 'vitest';
import { REWORK_LINES_MIN, REWORK_REEDIT_MIN_TURNS } from '../../../../shared/rpc';
import { REEDIT_MIN_TURNS, REWORKED_LINES_MIN } from '@agent-observability/core/src/analysis/rework';
import { filterChips, matchesFilters } from '../sessions/filters';
import type { SessionRow } from '../../../../shared/rpc';
import {
  REWORK_EXPLANATION,
  reworkRateLine,
  reworkSessionLine,
  reworkTooltip,
  reworkedFilter,
  showsReworkChip,
} from './rework';

describe('rework thresholds', () => {
  it('are the same numbers in the wire contract and in core', () => {
    expect(REWORK_REEDIT_MIN_TURNS).toBe(REEDIT_MIN_TURNS);
    expect(REWORK_LINES_MIN).toBe(REWORKED_LINES_MIN);
    expect(REWORK_EXPLANATION).toContain(String(REEDIT_MIN_TURNS));
    expect(REWORK_EXPLANATION).toContain(String(REWORKED_LINES_MIN));
    expect(REWORK_EXPLANATION).toContain('not a quality score');
  });
});

describe('showsReworkChip', () => {
  it('follows the same predicate as the Sessions filter', () => {
    expect(showsReworkChip({})).toBe(false);
    expect(showsReworkChip({ filesReedited: 1 })).toBe(true);
    expect(showsReworkChip({ reworkedLines: REWORK_LINES_MIN - 1 })).toBe(false);
    expect(showsReworkChip({ reworkedLines: REWORK_LINES_MIN })).toBe(true);
  });
});

describe('wording', () => {
  it('states the session’s own numbers, then what the signal means', () => {
    expect(reworkTooltip({ filesReedited: 2, reworkedLines: 1 })).toBe(
      `2 files edited repeatedly, 1 added line removed again. ${REWORK_EXPLANATION}`,
    );
    expect(reworkSessionLine({ filesReedited: 1, reworkedLines: 0 })).toBe('1 file re-edited');
    expect(reworkSessionLine({ filesReedited: 0, reworkedLines: 12 })).toBe('12 lines reworked');
  });

  it('gives the rate with its denominator, by hand', () => {
    expect(reworkRateLine(3, 12)).toBe('3 of 12 sessions that edited files (25%)');
    expect(reworkRateLine(1, 1)).toBe('1 of 1 session that edited files (100%)');
    expect(reworkRateLine(0, 0)).toBe('No analysed session in this window edited files');
  });
});

describe('the Sessions filter', () => {
  it('adds a clearable Rework chip and decides membership from the row', () => {
    const filters = reworkedFilter({ repository: 'r' });
    expect(filters).toEqual({ repository: 'r', reworked: true });
    expect(filterChips(filters).some((chip) => chip.key === 'reworked' && chip.label === 'Rework')).toBe(true);
    const row = { source: 'claude', repository: 'r', endedAtMs: 1 } as SessionRow;
    expect(matchesFilters({ ...row, filesReedited: 1 }, filters)).toBe(true);
    expect(matchesFilters(row, filters)).toBe(false);
  });
});
