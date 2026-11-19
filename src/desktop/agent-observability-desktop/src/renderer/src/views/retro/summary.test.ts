import { describe, expect, it } from 'vitest';
import type { EvidenceSummaryResult, SummaryDayPoint } from '../../../../shared/rpc';
import {
  DEFAULT_SUMMARY_SCOPE,
  buildSummaryDays,
  codeCoverageLine,
  editRecordingAgents,
  isoDay,
  readStoredScope,
  scopeFilters,
  scopeParams,
  toSummaryScope,
} from './summary';

/**
 * Dates are built with `new Date(y, m, d)` and compared through `isoDay`, so
 * nothing here depends on the runner's timezone or locale.
 */

describe('summary scope', () => {
  it('narrows untrusted stored values to a scope', () => {
    expect(toSummaryScope({ kind: 'tag', value: 'login' })).toEqual({ kind: 'tag', value: 'login' });
    expect(toSummaryScope({ kind: 'repository', value: '' })).toEqual({ kind: 'repository', value: '' });
    expect(toSummaryScope({ kind: 'branch', value: 'x' })).toEqual(DEFAULT_SUMMARY_SCOPE);
    expect(toSummaryScope({ kind: 'tag', value: 3 })).toEqual(DEFAULT_SUMMARY_SCOPE);
    expect(toSummaryScope(null)).toEqual(DEFAULT_SUMMARY_SCOPE);
    expect(toSummaryScope('tag')).toEqual(DEFAULT_SUMMARY_SCOPE);
  });

  it('falls back to the default where storage is unavailable', () => {
    expect(readStoredScope()).toEqual(DEFAULT_SUMMARY_SCOPE);
  });

  it('sends nothing for "all", else exactly one narrowing', () => {
    expect(scopeParams({ kind: 'repository', value: '' })).toEqual({});
    expect(scopeParams({ kind: 'tag', value: '' })).toEqual({});
    expect(scopeParams({ kind: 'repository', value: 'https://github.com/o/r' })).toEqual({
      repository: 'https://github.com/o/r',
    });
    expect(scopeParams({ kind: 'tag', value: 'login' })).toEqual({ tag: 'login' });
    expect(scopeFilters({ kind: 'tag', value: 'login' })).toEqual({ tag: 'login' });
  });
});

describe('summary day buckets', () => {
  const now = new Date(2026, 2, 10, 15, 30);
  const day = (offset: number): string => isoDay(new Date(2026, 2, 10 - offset));
  const point = (over: Partial<SummaryDayPoint> & Pick<SummaryDayPoint, 'day'>): SummaryDayPoint => ({
    source: 'claude',
    sessions: 1,
    costMicros: 100,
    linesAdded: 10,
    linesRemoved: 2,
    ...over,
  });

  it('draws one column per day, oldest first, ending today, empty days kept', () => {
    const days = buildSummaryDays([], 7, now);
    expect(days).toHaveLength(7);
    expect(days[0].iso).toBe(day(6));
    expect(days[6].iso).toBe(day(0));
    expect(days.every((d) => d.linesAdded === 0 && Object.keys(d.sessionsBySource).length === 0)).toBe(true);
  });

  it('folds each source into its day and drops rows outside the window', () => {
    const days = buildSummaryDays(
      [
        point({ day: day(0) }),
        point({ day: day(0), source: 'opencode', sessions: 2, costMicros: 50, linesAdded: 5, linesRemoved: 1 }),
        point({ day: day(30) }),
      ],
      3,
      now,
    );
    const today = days[days.length - 1];
    expect(today.sessionsBySource).toEqual({ claude: 1, opencode: 2 });
    expect(today.costBySource).toEqual({ claude: 100, opencode: 50 });
    expect(today.linesAdded).toBe(15);
    expect(today.linesRemoved).toBe(3);
    expect(days.reduce((n, d) => n + d.linesAdded, 0)).toBe(15);
  });

  it('always draws at least one column', () => {
    expect(buildSummaryDays([], 0, now)).toHaveLength(1);
  });
});

describe('code coverage line', () => {
  const summary = (
    sessions: number,
    coveredSessions: number,
    analyzedSessions: number,
  ): Pick<EvidenceSummaryResult, 'code' | 'totals'> => ({
    totals: {
      sessions,
      steps: 0,
      llmCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costMicros: 0,
      costSessions: 0,
      durationMs: 0,
      avgSessionMs: 0,
      repositories: 0,
      models: 0,
    },
    code: { linesAdded: 0, linesRemoved: 0, filesEdited: 0, coveredSessions, analyzedSessions },
  });

  it('says nothing when every session is covered and analyzed, or there are none', () => {
    expect(codeCoverageLine(summary(4, 4, 4))).toBeUndefined();
    expect(codeCoverageLine(summary(0, 0, 0))).toBeUndefined();
  });

  it('says when no session in scope can carry code figures, rather than showing zero', () => {
    const line = codeCoverageLine(summary(5, 0, 0));
    expect(line).toContain(editRecordingAgents());
    expect(line).toContain('none are in this scope');
  });

  it('names both kinds of partial coverage', () => {
    // Compare against the same formatter rather than a literal, so a locale
    // with a different digit grouping still passes.
    const line = codeCoverageLine(summary(1200, 10, 3));
    expect(line).toContain(`(${(10).toLocaleString()} of ${(1200).toLocaleString()})`);
    expect(line).toContain(`${(3).toLocaleString()} of ${(10).toLocaleString()} analyzed so far`);
    expect(codeCoverageLine(summary(10, 10, 3))).toBe(
      `${(3).toLocaleString()} of ${(10).toLocaleString()} analyzed so far`,
    );
  });

  it('lists the agents that record edits', () => {
    expect(editRecordingAgents()).toBe('Claude Code and OpenCode');
  });
});
