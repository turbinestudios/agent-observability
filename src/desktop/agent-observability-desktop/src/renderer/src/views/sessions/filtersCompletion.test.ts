import { describe, expect, it } from 'vitest';
import type { SessionRow } from '../../../../shared/rpc';
import { applyIntent, clearFilter, completionStatuses, filterChips, filterKey, matchesFilters, toListParams } from './filters';

function row(over: Partial<SessionRow> = {}): SessionRow {
  return {
    source: 'claude',
    sessionId: 's',
    repository: 'https://github.com/o/repo',
    startedAtMs: 1,
    endedAtMs: 2,
    durationMs: 1,
    interactionCount: 1,
    llmCalls: 1,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    model: 'm',
    agentModes: [],
    indexedAtMs: 1,
    ...over,
  };
}

describe('completion filters', () => {
  it('shows one chip for the whole completion filter and clears all three fields with it', () => {
    const filters = { completionIn: ['unverified' as const, 'contradicted' as const], claimedDone: true, repository: 'r' };
    const chip = filterChips(filters).find((c) => c.key === 'completion');
    expect(chip?.label).toBe('Reported done: Not verified or Check failed');
    expect(clearFilter(filters, 'completion')).toEqual({ repository: 'r' });
    expect(filterChips({ completion: 'incomplete' }).find((c) => c.key === 'completion')?.label).toBe('Left unfinished');
    expect(filterChips({ claimedDone: true }).find((c) => c.key === 'completion')?.label).toBe('Reported done');
  });

  it('merges the single and list forms without duplicates and keys the query on them', () => {
    expect(completionStatuses({ completion: 'unverified', completionIn: ['unverified', 'contradicted'] })).toEqual(['unverified', 'contradicted']);
    expect(filterKey({ completion: 'verified' })).not.toBe(filterKey({}));
    expect(filterKey({ claimedDone: true })).not.toBe(filterKey({}));
  });

  it('carries an intent through to the list parameters', () => {
    const applied = applyIntent({ completionIn: ['unverified', 'contradicted'], claimedDone: true });
    expect(toListParams(applied)).toMatchObject({ completionIn: ['unverified', 'contradicted'], claimedDone: true });
  });

  it('judges a pushed row from its own completion fields', () => {
    expect(matchesFilters(row({ completion: 'unverified', claimedDone: true }), { completionIn: ['unverified'], claimedDone: true })).toBe(true);
    expect(matchesFilters(row({ completion: 'verified' }), { completion: 'unverified' })).toBe(false);
    expect(matchesFilters(row(), { completion: 'unverified' })).toBe(false);
    expect(matchesFilters(row({ completion: 'unverified' }), { claimedDone: true })).toBe(false);
  });
});
