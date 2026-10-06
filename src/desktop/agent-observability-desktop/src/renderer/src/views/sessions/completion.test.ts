import { describe, expect, it } from 'vitest';
import { COMPLETION_STATUSES } from '../../../../shared/rpc';
import { completionLabel, completionTone, completionTooltip, showsCompletionChip } from './completion';

describe('completion chip', () => {
  it('labels every status', () => {
    expect(COMPLETION_STATUSES.map(completionLabel)).toEqual(['Verified', 'Not verified', 'Check failed', 'Left unfinished']);
    expect(completionTone('contradicted')).toBe('warn');
    expect(completionTone('verified')).toBe('good');
  });

  it('speaks only of what was observed, and always states the limits', () => {
    for (const status of COMPLETION_STATUSES) {
      const text = completionTooltip(status, true).toLowerCase();
      expect(text).toContain('based only on what this session recorded');
      expect(text).not.toMatch(/lied|lying|false claim|pretend|dishonest/);
    }
    expect(completionTooltip('unverified', true)).toContain('reported the work as done');
    expect(completionTooltip('unverified', false)).not.toContain('reported the work as done');
  });

  it('marks rows worth a look and leaves the rest quiet', () => {
    expect(showsCompletionChip({})).toBe(false);
    expect(showsCompletionChip({ completion: 'verified' })).toBe(false);
    expect(showsCompletionChip({ completion: 'unverified' })).toBe(false);
    expect(showsCompletionChip({ completion: 'unverified', claimedDone: true })).toBe(true);
    expect(showsCompletionChip({ completion: 'contradicted' })).toBe(true);
    expect(showsCompletionChip({ completion: 'incomplete' })).toBe(true);
  });
});
