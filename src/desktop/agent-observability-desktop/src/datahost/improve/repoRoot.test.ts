import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { resolveRepoRoot } from './repoRoot';

const REPO = 'github.com/acme/app';

/** A db stub over the two reverse queries, built per test. */
function db(cwds: string[], files: string[] = []) {
  return {
    cwdsForRepository: () => cwds.map((cwd, index) => ({ cwd, resolvedAtMs: 100 - index })),
    contextFilePathsForRepository: () => files,
  };
}

const ROOT = path.join('C:', 'work', 'app');

describe('resolveRepoRoot', () => {
  it('resolves the newest cwd whose root still belongs to the repository', () => {
    const result = resolveRepoRoot(REPO, db([path.join(ROOT, 'packages', 'web')]), {
      exists: () => true,
      findRoot: () => ROOT,
      resolveRepository: (root) => (root === ROOT ? REPO : 'unknown'),
    });
    expect(result).toEqual({ root: ROOT });
  });

  it('skips dead cwds and falls back to context-file directories', () => {
    const dead = path.join('C:', 'gone');
    const result = resolveRepoRoot(
      REPO,
      db([dead], [path.join(ROOT, '.claude', 'CLAUDE.md')]),
      {
        exists: (p) => p !== dead,
        findRoot: (start) => (start.startsWith(ROOT) ? ROOT : undefined),
        resolveRepository: () => REPO,
      },
    );
    expect(result).toEqual({ root: ROOT });
  });

  it('refuses a root whose remote no longer matches — a re-pointed checkout', () => {
    const result = resolveRepoRoot(REPO, db([ROOT]), {
      exists: () => true,
      findRoot: () => ROOT,
      resolveRepository: () => 'github.com/acme/forked-elsewhere',
    });
    expect('error' in result).toBe(true);
  });

  it('explains itself when nothing is known', () => {
    const result = resolveRepoRoot(REPO, db([]), { exists: () => true });
    expect('error' in result && result.error).toContain('No local checkout');
  });
});
