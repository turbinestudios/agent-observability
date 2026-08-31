import { describe, it, expect } from 'vitest';
import {
  applyIntent,
  clearFilter,
  dateLabel,
  dayRange,
  describeFilters,
  filterChips,
  filterKey,
  hasFilters,
  isoDayRange,
  matchesFilters,
} from './filters';
import { formatDay } from './format';
import type { SessionRow } from '../../../../shared/rpc';

/**
 * The rule these all serve: a filter that is applied must be visible and
 * clearable. A short list with no visible reason for being short is the failure
 * mode — the user cannot tell a filter from an empty index.
 */

/** 7 August 2026, local noon — inside the "current year" of `NOW`. */
const AUG_7 = new Date(2026, 7, 7, 12).getTime();
const AUG_9 = new Date(2026, 7, 9, 12).getTime();
const NOW = new Date(2026, 7, 20, 9).getTime();

/**
 * The day names are COMPUTED, never written out.
 *
 * `formatDay` delegates to `Intl`, whose output follows the machine's locale:
 * "7 Aug" on a European machine, "Aug 7" on the US-locale CI runner. Writing
 * either one here pins the test to whoever last ran it. What `dateLabel`
 * actually decides is the composition AROUND those names — collapsing a
 * one-day range to a single name, joining two ends, prefixing an open one —
 * and that is what these assert.
 */
const DAY_7 = formatDay(AUG_7, NOW);
const DAY_9 = formatDay(AUG_9, NOW);

describe('chips', () => {
  it('shows nothing when nothing is narrowed', () => {
    expect(filterChips({})).toEqual([]);
    expect(hasFilters({})).toBe(false);
  });

  it('leaves the source to its own chip row rather than showing it twice', () => {
    expect(filterChips({ source: 'claude' })).toEqual([]);
    expect(hasFilters({ source: 'claude' })).toBe(false);
  });

  it('shortens a repository but keeps the full name for the tooltip', () => {
    const [chip] = filterChips({ repository: 'github.com/acme/app' });
    expect(chip).toEqual({ key: 'repository', label: 'acme/app', title: 'github.com/acme/app' });
  });

  it('marks a tag so it cannot be mistaken for a repository', () => {
    expect(filterChips({ tag: 'experiment-A' })[0].label).toBe('#experiment-A');
  });

  it('keeps a fixed order, so chips do not reshuffle as filters are added', () => {
    const chips = filterChips(
      { repository: 'r', tag: 't', endedAfterMs: AUG_7, endedBeforeMs: AUG_9 },
      NOW,
    );
    expect(chips.map((c) => c.key)).toEqual(['repository', 'date', 'tag']);
  });

  it('labels a verdict chip in plain language and a signal chip by its theme', () => {
    expect(filterChips({ verdict: 'struggled' })[0]).toMatchObject({
      key: 'verdict',
      label: 'Struggled',
    });
    expect(filterChips({ signal: 'correction-reprompt' })[0]).toMatchObject({
      key: 'signal',
      label: 'Correction re-prompts',
    });
    // An unknown signal id still shows AS ITSELF — visible and clearable
    // beats hidden.
    expect(filterChips({ signal: 'future-signal' })[0].label).toBe('future-signal');
  });

  it('clears verdict and signal chips like any other dimension', () => {
    expect(clearFilter({ verdict: 'bumpy', signal: 's' }, 'verdict')).toEqual({ signal: 's' });
    expect(clearFilter({ verdict: 'bumpy', signal: 's' }, 'signal')).toEqual({ verdict: 'bumpy' });
  });

  it('keys and applies the new dimensions so drill-downs re-query and replace', () => {
    expect(filterKey({ verdict: 'bumpy' })).not.toBe(filterKey({}));
    expect(filterKey({ signal: 'a' })).not.toBe(filterKey({ signal: 'b' }));
    expect(applyIntent({ verdict: 'smooth', signal: 'rework-churn' })).toEqual({
      verdict: 'smooth',
      signal: 'rework-churn',
    });
  });
});

describe('date labels', () => {
  it('uses two genuinely different days, so the collapse below means something', () => {
    // Without this, a bug that made every day format identically would let the
    // one-day assertion pass for the wrong reason.
    expect(DAY_7).not.toBe(DAY_9);
  });

  it('names a single day once rather than as a range of itself', () => {
    const { endedAfterMs, endedBeforeMs } = dayRange(AUG_7);
    const label = dateLabel({ endedAfterMs, endedBeforeMs }, NOW);
    expect(label).toBe(DAY_7);
    expect(label).not.toContain('–');
  });

  it('shows both ends of a real range', () => {
    expect(dateLabel({ endedAfterMs: AUG_7, endedBeforeMs: AUG_9 }, NOW)).toBe(
      `${DAY_7} – ${DAY_9}`,
    );
  });

  it('says which end is open, so it cannot read as a single day', () => {
    expect(dateLabel({ endedAfterMs: AUG_7 }, NOW)).toBe(`From ${DAY_7}`);
    expect(dateLabel({ endedBeforeMs: AUG_9 }, NOW)).toBe(`Until ${DAY_9}`);
  });

  it('is absent when no dates are set', () => {
    expect(dateLabel({}, NOW)).toBeUndefined();
  });
});

describe('clearing', () => {
  it('drops one dimension and leaves the others', () => {
    const filters = { source: 'claude', repository: 'r', tag: 't' };
    expect(clearFilter(filters, 'repository')).toEqual({ source: 'claude', tag: 't' });
  });

  it('clears both date bounds together, since one chip covers both', () => {
    const cleared = clearFilter({ endedAfterMs: AUG_7, endedBeforeMs: AUG_9, tag: 't' }, 'date');
    expect(cleared).toEqual({ tag: 't' });
  });

  it('does not mutate the filters it was given', () => {
    const filters = { repository: 'r' };
    clearFilter(filters, 'repository');
    expect(filters).toEqual({ repository: 'r' });
  });
});

describe('day ranges', () => {
  it('covers a whole local day, inclusive at both ends', () => {
    const { endedAfterMs, endedBeforeMs } = dayRange(AUG_7);
    expect(new Date(endedAfterMs!).getHours()).toBe(0);
    expect(new Date(endedBeforeMs!).getHours()).toBe(23);
    expect(new Date(endedBeforeMs!).getDate()).toBe(7);
  });

  it('reads a YYYY-MM-DD day key as that local day', () => {
    // The overview's series reports local day keys; parsing them as UTC would
    // shift the range by a day for anyone west of Greenwich.
    expect(isoDayRange('2026-08-07')).toEqual(dayRange(AUG_7));
  });
});

describe('identity', () => {
  it('is equal for equal filters, whatever the object identity', () => {
    expect(filterKey({ source: 'claude', tag: 't' })).toBe(filterKey({ tag: 't', source: 'claude' }));
  });

  it('changes when any dimension changes', () => {
    const base = { source: 'claude' };
    expect(filterKey(base)).not.toBe(filterKey({ ...base, repository: 'r' }));
    expect(filterKey(base)).not.toBe(filterKey({ ...base, endedAfterMs: AUG_7 }));
    expect(filterKey(base)).not.toBe(filterKey({ ...base, tag: 't' }));
  });

  it('treats a blank value as unset, which is what a cleared dropdown produces', () => {
    expect(filterKey({ repository: '' })).toBe(filterKey({}));
  });
});

describe('arriving from another view', () => {
  it('replaces the narrowing filters rather than merging into them', () => {
    // Inheriting a tag set twenty minutes ago would show fewer sessions than
    // the bar that was just clicked, with nothing saying why.
    expect(applyIntent({ repository: 'r', endedAfterMs: AUG_7 })).toEqual({
      repository: 'r',
      endedAfterMs: AUG_7,
    });
  });

  it('clears everything for an empty intent', () => {
    expect(applyIntent({})).toEqual({});
  });
});

/**
 * The live-update path. A pushed row has to be placed correctly without a
 * re-query — merged in when it belongs, and taken OUT when an edit means it no
 * longer does. Missing the second half leaves a row sitting in a list it was
 * just removed from.
 */
describe('matching a pushed row', () => {
  function row(over: Partial<SessionRow> = {}): SessionRow {
    return {
      source: 'claude',
      sessionId: 'abc',
      repository: 'github.com/acme/app',
      startedAtMs: AUG_7,
      endedAtMs: AUG_7,
      durationMs: 1_000,
      interactionCount: 1,
      llmCalls: 1,
      toolCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: 0,
      model: 'claude-sonnet-4',
      agentModes: [],
      indexedAtMs: 1,
      ...over,
    };
  }

  it('accepts everything when nothing is narrowed', () => {
    expect(matchesFilters(row(), {})).toBe(true);
  });

  it('decides source and repository from the row', () => {
    expect(matchesFilters(row(), { source: 'copilot' })).toBe(false);
    expect(matchesFilters(row(), { source: 'claude' })).toBe(true);
    expect(matchesFilters(row(), { repository: 'github.com/acme/other' })).toBe(false);
  });

  it('places a row inside or outside the date range, inclusively', () => {
    expect(matchesFilters(row(), { endedAfterMs: AUG_9 })).toBe(false);
    expect(matchesFilters(row(), { endedBeforeMs: AUG_7 })).toBe(true);
    expect(matchesFilters(row({ endedAtMs: AUG_9 }), { endedBeforeMs: AUG_7 })).toBe(false);
  });

  it('reads tags off the row, so tagging updates the list without a re-query', () => {
    expect(matchesFilters(row({ tags: ['Experiment-A'] }), { tag: 'experiment-a' })).toBe(true);
    expect(matchesFilters(row({ tags: ['other'] }), { tag: 'experiment-a' })).toBe(false);
    // The row that just had its last tag removed must fall OUT of a tag filter.
    expect(matchesFilters(row(), { tag: 'experiment-a' })).toBe(false);
  });

  it('requires every active dimension, not any of them', () => {
    const filters = { source: 'claude', repository: 'github.com/acme/app', tag: 't' };
    expect(matchesFilters(row({ tags: ['t'] }), filters)).toBe(true);
    expect(matchesFilters(row({ tags: ['t'], source: 'copilot' }), filters)).toBe(false);
  });

  it('decides a verdict filter from the row, treating no verdict as no match', () => {
    expect(matchesFilters(row({ verdict: 'bumpy' }), { verdict: 'bumpy' })).toBe(true);
    expect(matchesFilters(row({ verdict: 'smooth' }), { verdict: 'bumpy' })).toBe(false);
    expect(matchesFilters(row(), { verdict: 'bumpy' })).toBe(false);
  });

  it('fails closed on a signal filter — the row cannot prove it qualifies', () => {
    expect(matchesFilters(row(), { signal: 'correction-reprompt' })).toBe(false);
  });
});

describe('describing a filtered empty state', () => {
  it('names every active dimension, source included', () => {
    expect(describeFilters({ source: 'claude', repository: 'github.com/acme/app', tag: 't' })).toBe(
      'Claude Code · acme/app · #t',
    );
  });

  it('is empty when nothing is narrowed', () => {
    expect(describeFilters({})).toBe('');
  });
});
