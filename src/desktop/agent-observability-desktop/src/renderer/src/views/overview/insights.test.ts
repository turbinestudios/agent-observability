import { describe, it, expect } from 'vitest';
import { VERDICT_SERIES, themeTitle, verdictColumns } from './insights';

/**
 * The hero's data shaping: sparse day × verdict rows land in the same day
 * buckets the other charts draw, and never anywhere else.
 */

const days = [
  { iso: '2026-08-01', short: '1 Aug', long: 'Sat 1 Aug' },
  { iso: '2026-08-02', short: '2 Aug', long: 'Sun 2 Aug' },
];

describe('verdictColumns', () => {
  it('places counts on their day, zero-filling the rest', () => {
    const columns = verdictColumns(days, [
      { day: '2026-08-01', verdict: 'smooth', sessions: 3 },
      { day: '2026-08-01', verdict: 'unjudged', sessions: 1 },
      { day: '2026-08-02', verdict: 'struggled', sessions: 2 },
    ]);

    expect(columns).toHaveLength(2);
    const first = new Map(columns[0].segments.map((s) => [s.key, s.value]));
    expect(first.get('smooth')).toBe(3);
    expect(first.get('unjudged')).toBe(1);
    expect(first.get('struggled')).toBe(0);
    const second = new Map(columns[1].segments.map((s) => [s.key, s.value]));
    expect(second.get('struggled')).toBe(2);
    expect(second.get('smooth')).toBe(0);
  });

  it('drops rows outside the buckets, as buildDays drops its strays', () => {
    const columns = verdictColumns(days, [{ day: '2030-01-01', verdict: 'smooth', sessions: 5 }]);
    expect(columns.every((c) => c.segments.every((s) => s.value === 0))).toBe(true);
  });

  it('emits a segment for every series in the fixed verdict order', () => {
    const [column] = verdictColumns([days[0]], []);
    expect(column.segments.map((s) => s.key)).toEqual(VERDICT_SERIES.map((s) => s.key));
  });
});

describe('themeTitle', () => {
  it('spells out both figures, singular and plural', () => {
    expect(themeTitle({ signalId: 'x', sessions: 1, occurrences: 1 })).toBe(
      '1 occurrence across 1 session',
    );
    expect(themeTitle({ signalId: 'x', sessions: 4, occurrences: 9 })).toBe(
      '9 occurrences across 4 sessions',
    );
  });
});
