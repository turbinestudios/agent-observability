import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Read-only snapshot of the live Copilot telemetry DB.
 *
 * `agent-traces.db` runs in WAL mode and is typically held open by VS Code's
 * Copilot writer, so the freshest committed data may live only in the `-wal`
 * sidecar, not yet checkpointed into the main `.db`. To get a consistent
 * snapshot WITHOUT any lock contention or write risk against the real file, we:
 *
 *   1. Copy `*.db` plus its `*.db-wal` and `*.db-shm` sidecars (when present)
 *      to a private temp directory, as close together in time as possible.
 *   2. Callers open the COPY read-only (node-sqlite3-wasm { readOnly: true }).
 *      SQLite replays the copied WAL on first open, so the reader sees the
 *      latest committed state.
 *   3. {@link ReadonlySnapshot.dispose} deletes the temp copy.
 *
 * We NEVER open, checkpoint, or write the original file.
 */
export interface ReadonlySnapshot {
  /** Absolute path to the copied `.db` file inside the temp dir. */
  dbPath: string;
  /** Source mtime (epoch ms) captured at copy time, for skip-if-unchanged. */
  sourceMtimeMs: number;
  /** Delete the temp copy and its sidecars. Safe to call more than once. */
  dispose(): void;
}

const WAL_SUFFIX = '-wal';
const SHM_SUFFIX = '-shm';

/**
 * Create a read-only snapshot copy of the database at `dbPath`.
 *
 * @throws if the source `.db` does not exist or cannot be read (the caller's
 * service layer classifies the error code, e.g. ENOENT → missingDb,
 * EACCES/EPERM → permission).
 */
export function createReadonlySnapshot(dbPath: string): ReadonlySnapshot {
  // Capture source mtime first; surfaces ENOENT/EACCES before any temp work.
  const sourceStat = fs.statSync(dbPath);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-'));
  const baseName = path.basename(dbPath);
  const destDb = path.join(tempDir, baseName);

  // Copy main DB first, then sidecars. Sidecars are optional (a cleanly
  // checkpointed DB may have none); copy them only when present.
  fs.copyFileSync(dbPath, destDb);
  copyIfExists(dbPath + WAL_SUFFIX, destDb + WAL_SUFFIX);
  copyIfExists(dbPath + SHM_SUFFIX, destDb + SHM_SUFFIX);

  let disposed = false;
  return {
    dbPath: destDb,
    sourceMtimeMs: sourceStat.mtimeMs,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; a leftover temp file is harmless and the OS
        // reclaims tmpdir. Never throw from dispose.
      }
    },
  };
}

/** Copy `from` → `to` only if `from` exists; ignore a benign race ENOENT. */
function copyIfExists(from: string, to: string): void {
  try {
    fs.copyFileSync(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

/** Current mtime (epoch ms) of a source DB, or `undefined` if unreadable. */
export function sourceMtime(dbPath: string): number | undefined {
  try {
    return fs.statSync(dbPath).mtimeMs;
  } catch {
    return undefined;
  }
}
