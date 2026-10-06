import { describe, expect, it } from 'vitest';
import type { CompletionSummary } from '../../../../shared/rpc';
import { completionRows, percentOf, reportedDoneFilter, reportedDoneLine, statusFilter } from './completionCounts';

const summary: CompletionSummary = {
  verified: 6,
  unverified: 3,
  contradicted: 1,
  incomplete: 2,
  changedCode: 12,
  reportedDoneUnverified: 3,
};

describe('completion tab', () => {
  it('lists every status with its share of sessions that changed code', () => {
    const rows = completionRows(summary);
    expect(rows.map((r) => r.label)).toEqual(['Verified', 'Not verified', 'Check failed', 'Left unfinished']);
    expect(rows.map((r) => r.pct)).toEqual([50, 25, 8, 17]);
    expect(percentOf(1, 0)).toBe(0);
  });

  it('always states the denominator in the headline', () => {
    expect(reportedDoneLine(summary)).toBe('3 of 12 sessions that changed code (25%)');
    expect(reportedDoneLine({ ...summary, changedCode: 1, reportedDoneUnverified: 1 })).toBe('1 of 1 session that changed code (100%)');
    expect(reportedDoneLine({ ...summary, changedCode: 0, reportedDoneUnverified: 0 })).toContain('No session');
  });

  it('builds drill-downs that keep the caller scope', () => {
    expect(reportedDoneFilter({ repository: 'r' })).toEqual({
      repository: 'r',
      completionIn: ['unverified', 'contradicted'],
      claimedDone: true,
    });
    expect(statusFilter({ source: 'claude' }, 'incomplete')).toEqual({ source: 'claude', completion: 'incomplete' });
  });
});
