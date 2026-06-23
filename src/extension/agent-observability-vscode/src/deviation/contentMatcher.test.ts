import { describe, it, expect } from 'vitest';
import {
  matchesContent,
  safeRegexTest,
  isSafeRegexSource,
  MAX_CONTENT_LENGTH,
  MAX_REGEX_INPUT_LENGTH,
  MAX_PATTERN_LENGTH,
} from './contentMatcher';
import { ContentPredicate } from './models';

const ATTR = 'copilot_chat.user_request';
function cp(overrides: Partial<ContentPredicate>): ContentPredicate {
  return { attribute: ATTR, ...overrides };
}

describe('matchesContent — contains', () => {
  it('matches case-insensitively', () => {
    expect(matchesContent('Please FIX the Bug', cp({ contains: 'fix the bug' }))).toBe(true);
    expect(matchesContent('nothing here', cp({ contains: 'fix the bug' }))).toBe(false);
  });

  it('inverts with negate', () => {
    expect(matchesContent('contains AKIA secret', cp({ contains: 'AKIA', negate: true }))).toBe(false);
    expect(matchesContent('clean prompt', cp({ contains: 'AKIA', negate: true }))).toBe(true);
  });

  it('prefers contains over matches (regex never consulted when contains is set)', () => {
    // The matches pattern is catastrophic, but contains short-circuits before it.
    const predicate = cp({ contains: 'ok', matches: '(a+)+$' });
    expect(matchesContent('this is ok', predicate)).toBe(true);
    expect(matchesContent('not present', predicate)).toBe(false);
  });
});

describe('matchesContent — matches (regex)', () => {
  it('tests a well-formed pattern', () => {
    expect(matchesContent('src/extension/foo.ts', cp({ matches: 'src/.*\\.ts$' }))).toBe(true);
    expect(matchesContent('README.md', cp({ matches: 'src/.*\\.ts$' }))).toBe(false);
  });

  it('inverts a regex with negate', () => {
    expect(matchesContent('README.md', cp({ matches: 'src/.*\\.ts$', negate: true }))).toBe(true);
  });

  it('treats an invalid pattern as a non-match (never throws)', () => {
    expect(matchesContent('anything', cp({ matches: '[' }))).toBe(false);
  });
});

describe('input length cap', () => {
  it('truncates to MAX_CONTENT_LENGTH before matching (a match past the cap is not found)', () => {
    const value = 'x'.repeat(MAX_CONTENT_LENGTH) + 'SECRET';
    expect(matchesContent(value, cp({ contains: 'SECRET' }))).toBe(false);
  });

  it('still finds a match within the cap', () => {
    const value = 'SECRET' + 'x'.repeat(MAX_CONTENT_LENGTH);
    expect(matchesContent(value, cp({ contains: 'SECRET' }))).toBe(true);
  });

  it('uses the tighter MAX_REGEX_INPUT_LENGTH window for regex (bounds backtracking)', () => {
    expect(MAX_REGEX_INPUT_LENGTH).toBeLessThan(MAX_CONTENT_LENGTH);
    // A regex match that only appears beyond the regex window is NOT found...
    const beyond = 'x'.repeat(MAX_REGEX_INPUT_LENGTH) + 'TARGET';
    expect(matchesContent(beyond, cp({ matches: 'TARGET' }))).toBe(false);
    // ...yet `contains` (10k window) still finds the same text.
    expect(matchesContent(beyond, cp({ contains: 'TARGET' }))).toBe(true);
    // A regex match within the window is found.
    const within = 'TARGET' + 'x'.repeat(MAX_REGEX_INPUT_LENGTH);
    expect(matchesContent(within, cp({ matches: '^TARGET' }))).toBe(true);
  });
});

describe('safeRegexTest — ReDoS / pattern guards', () => {
  const evil = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!'; // would catastrophically backtrack

  it('rejects nested unbounded quantifiers (treated as non-match, not a hang)', () => {
    expect(safeRegexTest('(a+)+$', evil)).toBe(false);
    expect(safeRegexTest('(a*)*$', evil)).toBe(false);
    expect(safeRegexTest('(.+)+$', evil)).toBe(false);
    expect(safeRegexTest('([a-z]+)*$', evil)).toBe(false);
    expect(safeRegexTest('(a{2,})+', evil)).toBe(false);
  });

  it('rejects ambiguous-alternation and bounded-outer polynomial families', () => {
    expect(safeRegexTest('(a|a)*$', evil)).toBe(false);
    expect(safeRegexTest('(a|aa)+$', evil)).toBe(false);
    expect(safeRegexTest('(a|ab)*$', evil)).toBe(false);
    expect(safeRegexTest('(?:a|aa)+$', evil)).toBe(false);
    expect(safeRegexTest('(.*a){20}$', evil)).toBe(false);
    // Disjoint alternation under repetition is rejected too (safe-not-clever).
    expect(safeRegexTest('(a|b)+', 'abab')).toBe(false);
  });

  it('rejects nested VARIABLE-bounded quantifiers (bounded but ambiguous → backtracks)', () => {
    expect(safeRegexTest('(a{1,10}){1,10}$', evil)).toBe(false);
    expect(safeRegexTest('(a{1,2}){1,2}$', evil)).toBe(false);
    expect(safeRegexTest('((((a{1,2}){1,2}){1,2}){1,2})$', evil)).toBe(false);
    expect(safeRegexTest('(?:a{1,2}){1,2}$', evil)).toBe(false);
  });

  it('rejects adjacent identical variable quantifiers (group-free polynomial family)', () => {
    const digits = '1'.repeat(40) + 'x';
    expect(safeRegexTest('a*a*$', evil)).toBe(false);
    expect(safeRegexTest('a*a*a*$', evil)).toBe(false);
    expect(safeRegexTest('\\d*\\d*\\d*\\d*\\d*$', digits)).toBe(false);
    expect(safeRegexTest('[a-z]*[a-z]*$', evil)).toBe(false);
    expect(safeRegexTest('.*.*$', evil)).toBe(false);
    expect(safeRegexTest('a+a+a+$', evil)).toBe(false);
    // Grouped variant is caught via recursion into the group body.
    expect(safeRegexTest('(a*a*)$', evil)).toBe(false);
  });

  it('allows adjacent DISJOINT quantifiers (different atoms cannot overlap)', () => {
    expect(safeRegexTest('\\w+\\s+\\w+', 'foo bar')).toBe(true);
    expect(safeRegexTest('\\d+\\.\\d+', '3.14')).toBe(true);
    expect(safeRegexTest('a*b*', 'aabb')).toBe(true);
  });

  it('allows safe patterns (single quantifier, EXACT-count bodies, char classes, non-repeated alternation)', () => {
    expect(safeRegexTest('a{2,}b', 'aaab')).toBe(true);
    expect(safeRegexTest('[ab]+', 'abab')).toBe(true);
    expect(safeRegexTest('src/.*\\.ts$', 'src/x.ts')).toBe(true);
    expect(safeRegexTest('(?:abc)+', 'abcabc')).toBe(true);
    expect(safeRegexTest('(foo)+', 'foofoo')).toBe(true);
    expect(safeRegexTest('(\\d{3})+', '123456')).toBe(true);
    // Exact-count nesting is deterministic (no ambiguity) → allowed.
    expect(safeRegexTest('(a{2}){2}', 'aaaa')).toBe(true);
    expect(safeRegexTest('((a{2}){2}){2}', 'a'.repeat(8))).toBe(true);
    // Alternation NOT under a repetition is fine.
    expect(safeRegexTest('(a|b)c', 'ac')).toBe(true);
    // A bounded outer with a bounded body is fine.
    expect(safeRegexTest('(ab){3}', 'ababab')).toBe(true);
  });

  it('rejects an empty or over-long pattern', () => {
    expect(safeRegexTest('', 'anything')).toBe(false);
    expect(safeRegexTest('a'.repeat(MAX_PATTERN_LENGTH + 1), 'aaa')).toBe(false);
  });

  it('returns false for a non-matching valid pattern', () => {
    expect(safeRegexTest('^foo$', 'bar')).toBe(false);
  });
});

describe('isSafeRegexSource', () => {
  it('accepts safe patterns and rejects dangerous/invalid/empty ones', () => {
    expect(isSafeRegexSource('src/.*\\.ts$')).toBe(true);
    expect(isSafeRegexSource('[ab]+')).toBe(true);
    expect(isSafeRegexSource('(a{2}){2}')).toBe(true);
    expect(isSafeRegexSource('\\w+\\s+\\w+')).toBe(true);
    expect(isSafeRegexSource('(a+)+')).toBe(false);
    expect(isSafeRegexSource('(a|a)*')).toBe(false);
    expect(isSafeRegexSource('(.*a){20}')).toBe(false);
    expect(isSafeRegexSource('(a{1,2}){1,2}')).toBe(false);
    expect(isSafeRegexSource('a*a*')).toBe(false);
    expect(isSafeRegexSource('[')).toBe(false);
    expect(isSafeRegexSource('')).toBe(false);
  });
});
