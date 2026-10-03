import * as path from 'node:path';
import { scanContextInventory } from '@agent-observability/core/src/context/contextInventory';
import type { ContextInventory, ContextInventoryFile, HotspotRow } from '../../shared/rpc';
import type { IndexDb } from '../indexer/indexDb';
import { resolveRepoRoot, type RepoRootSeams } from '../improve/repoRoot';

/**
 * The repository hub's "Rules & Skills" table: every context file found on
 * disk in the repository's checkout, joined with how often indexed sessions
 * actually loaded or skipped it.
 *
 * The two sides meet on the ABSOLUTE path. The index stores the path discovery
 * handed it (built with `path.join`), the inventory walk builds its own; on
 * Windows the two can differ in case or separators for the same file, so both
 * are normalized — and lower-cased on win32 only — before the join.
 *
 * Usage rows whose file lies outside the checkout (the user's own
 * `~/.claude/CLAUDE.md`, say) are returned separately: they shape the agent in
 * this repository too, but no inventory row can own them.
 */
export interface InventorySeams extends RepoRootSeams {
  scan?: typeof scanContextInventory;
  platform?: NodeJS.Platform;
}

export function inventoryForRepository(
  repository: string,
  db: IndexDb,
  hiddenKeys: readonly string[],
  seams: InventorySeams = {},
): ContextInventory | { error: string } {
  const resolved = resolveRepoRoot(repository, db, seams);
  if ('error' in resolved) {
    return { error: resolved.error };
  }
  const root = resolved.root;
  const scan = seams.scan ?? scanContextInventory;
  const inventory = scan(root);

  const usage = db.hotspots({ repository }, hiddenKeys);
  const byPath = new Map<string, HotspotRow>();
  for (const row of usage) {
    if (path.isAbsolute(row.file)) {
      byPath.set(normalizeKey(row.file, seams.platform), row);
    }
  }

  const files: ContextInventoryFile[] = inventory.files.map((file) => {
    const absolute = path.join(root, ...file.relPath.split('/'));
    const key = normalizeKey(absolute, seams.platform);
    const row = byPath.get(key);
    if (row !== undefined) {
      byPath.delete(key);
    }
    return {
      relPath: file.relPath,
      kind: file.kind,
      agent: file.agent,
      bytes: file.bytes,
      estTokens: file.estTokens,
      ...(row !== undefined
        ? {
            usage: {
              file: row.file,
              sessionCount: row.sessionCount,
              appliedCount: row.appliedCount,
              skippedCount: row.skippedCount,
              readCount: row.readCount,
              estTokensMax: row.estTokensMax,
              lastSeenMs: row.lastSeenMs,
            },
          }
        : {}),
    };
  });

  // Whatever usage did not match an inventory row: either outside the checkout
  // or a file that has since been deleted. Both are worth seeing.
  const rootKey = normalizeKey(root, seams.platform) + path.sep;
  const outsideRepo = [...byPath.values()].filter(
    (row) => !normalizeKey(row.file, seams.platform).startsWith(rootKey),
  );

  return { root, files, outsideRepo, truncated: inventory.truncated };
}

function normalizeKey(file: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = path.normalize(path.resolve(file));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
