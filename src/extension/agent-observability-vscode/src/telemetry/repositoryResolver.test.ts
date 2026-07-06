import { describe, it, expect } from 'vitest';
import { RepositoryResolver } from './repositoryResolver';
import { UNKNOWN_REPOSITORY } from './repositoryUrl';

const REPO_X = 'https://github.com/org/x';
const REPO_Y = 'https://github.com/org/y';

describe('RepositoryResolver scoped fallback', () => {
  it('uses the fallback only for sessions with no remote of their own', () => {
    const resolver = RepositoryResolver.fromMap(new Map([['sessA', REPO_X]]));

    // No fallback yet: mapped wins, everything else is unknown.
    expect(resolver.resolve('sessA')).toBe(REPO_X);
    expect(resolver.resolve('sessB')).toBe(UNKNOWN_REPOSITORY);

    resolver.setFallback((id) => (id === 'sessB' ? REPO_Y : undefined));

    // A session that recorded its own remote is never overridden by the fallback.
    expect(resolver.resolve('sessA')).toBe(REPO_X);
    // A claimed session gets the fallback repo…
    expect(resolver.resolve('sessB')).toBe(REPO_Y);
    // …an unclaimed one stays unknown.
    expect(resolver.resolve('sessC')).toBe(UNKNOWN_REPOSITORY);
  });

  it('treats a fallback returning unknown/empty as no fallback', () => {
    const resolver = RepositoryResolver.fromMap(new Map());
    resolver.setFallback(() => UNKNOWN_REPOSITORY);
    expect(resolver.resolve('sess')).toBe(UNKNOWN_REPOSITORY);
    resolver.setFallback(() => '');
    expect(resolver.resolve('sess')).toBe(UNKNOWN_REPOSITORY);
  });

  it('clears the fallback when set to undefined', () => {
    const resolver = RepositoryResolver.fromMap(new Map());
    resolver.setFallback((id) => (id === 'sess' ? REPO_X : undefined));
    expect(resolver.resolve('sess')).toBe(REPO_X);
    resolver.setFallback(undefined);
    expect(resolver.resolve('sess')).toBe(UNKNOWN_REPOSITORY);
  });

  it('returns unknown for null/empty keys regardless of fallback', () => {
    const resolver = RepositoryResolver.fromMap(new Map());
    resolver.setFallback(() => REPO_X);
    expect(resolver.resolve(null)).toBe(UNKNOWN_REPOSITORY);
    expect(resolver.resolve(undefined)).toBe(UNKNOWN_REPOSITORY);
    expect(resolver.resolve('')).toBe(UNKNOWN_REPOSITORY);
  });
});
