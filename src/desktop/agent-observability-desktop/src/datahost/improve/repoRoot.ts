import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  findRepoRoot,
  resolveWorkspaceRepository,
} from '@agent-observability/core/src/chat/tasks/projectContext';
import type { IndexDb } from '../indexer/indexDb';

/**
 * Resolve a repository (the sanitized remote URL sessions are grouped by) back
 * to a local checkout — the reverse mapping the index never needed until the
 * improvement plan had to READ and WRITE the repo's context files.
 *
 * Candidates come from the session evidence itself: cached session cwds
 * (newest resolution first), then the directories of context files seen in the
 * repository's sessions. Each candidate is climbed to its `.git` root, and the
 * root only qualifies when its remote still sanitizes to the SAME repository —
 * the guard against moved checkouts and re-pointed remotes.
 */

/** Injectable seams so tests use fixture repos, not this machine's checkouts. */
export interface RepoRootSeams {
  findRoot?: (startDir: string) => string | undefined;
  resolveRepository?: (root: string) => string;
  exists?: (p: string) => boolean;
}

export function resolveRepoRoot(
  repository: string,
  db: Pick<IndexDb, 'cwdsForRepository' | 'contextFilePathsForRepository'>,
  seams: RepoRootSeams = {},
): { root: string } | { error: string } {
  const findRoot = seams.findRoot ?? findRepoRoot;
  const resolveRepository = seams.resolveRepository ?? resolveWorkspaceRepository;
  const exists = seams.exists ?? fs.existsSync;

  const candidates = [
    ...db.cwdsForRepository(repository).map((row) => row.cwd),
    ...db.contextFilePathsForRepository(repository).map((file) => path.dirname(file)),
  ];

  const tried = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.length === 0 || tried.has(candidate) || !exists(candidate)) {
      continue;
    }
    tried.add(candidate);
    const root = findRoot(candidate);
    if (root === undefined) {
      continue;
    }
    if (resolveRepository(root) === repository) {
      return { root };
    }
  }
  return {
    error:
      'No local checkout of this repository is known. Run an agent session in it once — or check that the folder still exists and its git remote still matches.',
  };
}
