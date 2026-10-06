import type { ReworkFileRow } from '../../shared/rpc';
import type { IndexDb } from '../indexer/indexDb';
import { promptSafePath } from '../improve/contextPlan';
import { resolveRepoRoot, type RepoRootSeams } from '../improve/repoRoot';

/**
 * Turn the Rework ranking's file rows into what the renderer may show.
 *
 * The index stores the path as the transcript recorded it, which is absolute
 * and LOCAL-ONLY. Nothing absolute crosses the RPC boundary here: a file is
 * shown relative to its repository's verified checkout root, and when the
 * root cannot be resolved, or the file lies outside it, by its bare name.
 * Roots are resolved once per repository per call.
 */
export function reworkFileRows(
  rows: readonly { file: string; repository: string; sessions: number; editTurns: number; reworkedLines: number; outsideRepo: boolean }[],
  db: Pick<IndexDb, 'cwdsForRepository' | 'contextFilePathsForRepository'>,
  seams: RepoRootSeams = {},
): ReworkFileRow[] {
  const roots = new Map<string, string | undefined>();
  const rootFor = (repository: string): string | undefined => {
    if (!roots.has(repository)) {
      const resolved = repository === 'unknown' ? { error: 'unknown' } : resolveRepoRoot(repository, db, seams);
      roots.set(repository, 'root' in resolved ? resolved.root : undefined);
    }
    return roots.get(repository);
  };
  return rows.map((row) => {
    const root = row.outsideRepo ? undefined : rootFor(row.repository);
    return {
      path: root !== undefined ? promptSafePath(row.file, root) : bareName(row.file),
      repository: row.repository,
      sessions: row.sessions,
      editTurns: row.editTurns,
      reworkedLines: row.reworkedLines,
      outsideRepo: row.outsideRepo,
    };
  });
}

function bareName(file: string): string {
  const parts = file.split(/[\\/]/).filter((s) => s.length > 0);
  return parts.length === 0 ? file : parts[parts.length - 1];
}
