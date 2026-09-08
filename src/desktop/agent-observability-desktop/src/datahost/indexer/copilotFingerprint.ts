import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A cheap change token for a Copilot database AND its WAL. Looking only at the
 * main file misses committed writes until SQLite checkpoints them. SHM and
 * access times are deliberately excluded: readers can change those themselves.
 *
 * This is conservative, database-wide invalidation, not a content hash. A
 * changed token invalidates even sessions whose summary counts did not move,
 * since an error, tool argument, or sub-agent may have changed instead. File
 * identity and change time also catch replacements with preserved mtimes.
 * Never read the multi-gigabyte contents merely to decide whether to reuse them.
 *
 * Unreadable metadata means UNKNOWN, never "unchanged". Callers sample before
 * and after their queries and reuse a token only when both samples agree.
 */
export function copilotFingerprint(dbPath: string): string | undefined {
  try {
    const main = fileFingerprint(dbPath);
    let wal: string[] | null;
    try {
      wal = fileFingerprint(`${dbPath}-wal`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
      wal = null;
    }
    return JSON.stringify([path.resolve(dbPath), main, wal]);
  } catch {
    return undefined;
  }
}

function fileFingerprint(file: string): string[] {
  const stat = fs.statSync(file, { bigint: true });
  if (!stat.isFile()) {
    throw new Error('Not a database file');
  }
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.birthtimeNs].map(String);
}