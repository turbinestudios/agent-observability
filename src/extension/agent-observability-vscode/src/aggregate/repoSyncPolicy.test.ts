import { describe, it, expect } from 'vitest';
import {
  buildRepoSyncPolicy,
  isRepositoryIncluded,
  filterRowsByPolicy,
  normalizeRepositoryList,
  ALL_REPOSITORIES_POLICY,
} from './repoSyncPolicy';

/**
 * Unit tests for the per-repository sync scoping policy. Pin the privacy-relevant
 * invariants: `all` uploads everything (the opt-in escape hatch), `include`
 * (the default) / `exclude` are exact-membership over the SANITIZED repository
 * form, hand-edited entries are normalized through the same sanitizer the rows
 * use, and an invalid mode fails safe to `all` (never silently dropping uploads).
 */

const REPO_A = 'https://github.com/example-org/repo-a';
const REPO_B = 'https://github.com/example-org/repo-b';

describe('buildRepoSyncPolicy', () => {
  it('returns the all-repositories policy for mode "all" regardless of list', () => {
    const policy = buildRepoSyncPolicy('all', [REPO_A]);
    expect(policy.mode).toBe('all');
    expect(policy.repositories.size).toBe(0);
  });

  it('falls back to "all" for an unrecognized (hand-edited) mode', () => {
    const policy = buildRepoSyncPolicy('only-mine', [REPO_A]);
    expect(policy).toEqual(ALL_REPOSITORIES_POLICY);
  });

  it('normalizes list entries through the repository sanitizer', () => {
    // SCP-style remote, shorthand-with-.git, and odd casing all canonicalize to
    // the same form the row values carry.
    const policy = buildRepoSyncPolicy('include', [
      'git@github.com:example-org/repo-a.git',
      'https://github.com/Example-Org/Repo-B',
    ]);
    expect(policy.repositories.has(REPO_A)).toBe(true);
    expect(isRepositoryIncluded(REPO_A, policy)).toBe(true);
  });

  it('passes the literal "unknown" token through verbatim', () => {
    const policy = buildRepoSyncPolicy('include', ['unknown']);
    expect(policy.repositories.has('unknown')).toBe(true);
    expect(isRepositoryIncluded('unknown', policy)).toBe(true);
    expect(isRepositoryIncluded(REPO_A, policy)).toBe(false);
  });

  it('ignores empty / whitespace-only entries', () => {
    const policy = buildRepoSyncPolicy('include', ['', '   ', REPO_A]);
    expect(policy.repositories.size).toBe(1);
  });
});

describe('normalizeRepositoryList', () => {
  it('canonicalizes entries, preserves "unknown", and skips blanks', () => {
    // The same normalization backs both the sync scope and the local
    // `excludedRepositories` filter, so shorthand entries match row values.
    const set = normalizeRepositoryList([
      'git@github.com:example-org/repo-a.git',
      ' unknown ',
      '',
      '   ',
    ]);
    expect(set).toEqual(new Set([REPO_A, 'unknown']));
  });
});

describe('isRepositoryIncluded', () => {
  it('admits everything under "all"', () => {
    expect(isRepositoryIncluded(REPO_A, ALL_REPOSITORIES_POLICY)).toBe(true);
    expect(isRepositoryIncluded('unknown', ALL_REPOSITORIES_POLICY)).toBe(true);
  });

  it('admits only listed repos under "include"', () => {
    const policy = buildRepoSyncPolicy('include', [REPO_A]);
    expect(isRepositoryIncluded(REPO_A, policy)).toBe(true);
    expect(isRepositoryIncluded(REPO_B, policy)).toBe(false);
  });

  it('admits all but listed repos under "exclude"', () => {
    const policy = buildRepoSyncPolicy('exclude', [REPO_A]);
    expect(isRepositoryIncluded(REPO_A, policy)).toBe(false);
    expect(isRepositoryIncluded(REPO_B, policy)).toBe(true);
  });
});

describe('filterRowsByPolicy', () => {
  const rows = [
    { repository: REPO_A, n: 1 },
    { repository: REPO_B, n: 2 },
    { repository: 'unknown', n: 3 },
  ];

  it('returns a copy of all rows under "all"', () => {
    const out = filterRowsByPolicy(rows, ALL_REPOSITORIES_POLICY);
    expect(out).toHaveLength(3);
    expect(out).not.toBe(rows);
  });

  it('keeps only included rows under "include"', () => {
    const out = filterRowsByPolicy(rows, buildRepoSyncPolicy('include', [REPO_A]));
    expect(out.map((r) => r.n)).toEqual([1]);
  });

  it('drops excluded rows under "exclude"', () => {
    const out = filterRowsByPolicy(rows, buildRepoSyncPolicy('exclude', [REPO_A, 'unknown']));
    expect(out.map((r) => r.n)).toEqual([2]);
  });
});
