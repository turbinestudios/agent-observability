import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Discovery of Copilot `agent-traces.db` files on the WINDOWS HOST from inside
 * a WSL distro, for the case where this extension runs in a Remote-WSL window
 * while the user's Copilot activity (also) happens in desktop VS Code on the
 * host. There, Copilot Chat writes its globalStorage under
 * `%APPDATA%\Code[ - Insiders]`, which WSL can read through the default
 * drvfs mount at `/mnt/c`.
 *
 * The mirror image of {@link ./wslPaths.findWslDatabases}: that module lets the
 * Windows host see distro-side databases over `\\wsl.localhost`; this one lets
 * a distro-side extension host see the Windows databases. Both feed
 * {@link ./paths.resolveDatabasePaths}, which merges every environment's
 * database into one view.
 *
 * All paths here are built with `path.posix` explicitly: `/mnt/c` is a
 * Linux-side concept regardless of where unit tests run. Discovery is total —
 * a machine without the mount (plain Linux, custom wsl.conf root) simply
 * yields no candidates.
 */

/** A database found on the Windows host, reachable through `/mnt/c`. */
export interface WindowsHostDatabaseCandidate {
  /** Full `/mnt/c/...` path to the `agent-traces.db` file. */
  path: string;
  /** Source-file mtime, used to prefer the most recently active install. */
  mtimeMs: number;
  /** Windows user the file was found under, for diagnostics. */
  user: string;
}

/**
 * I/O seam so discovery is unit-testable without WSL. Every operation is
 * total: errors are expressed as `undefined`/empty, never thrown.
 */
export interface WindowsHostDiscoveryDeps {
  /** Entry names of a directory, or `undefined` when it cannot be listed. */
  readDir(dirPath: string): string[] | undefined;
  /** mtime (ms) when the path is a readable regular file, else `undefined`. */
  fileMtimeMs(filePath: string): number | undefined;
}

/** The drvfs mount of the Windows users directory in a default WSL setup. */
const WINDOWS_USERS_DIR = '/mnt/c/Users';

/** Desktop VS Code variant directories under `%APPDATA%`. */
const CODE_VARIANTS = ['Code', 'Code - Insiders'];

/** DB location inside a variant's user-data dir, mirroring paths.ts. */
const DB_RELATIVE = path.posix.join(
  'User',
  'globalStorage',
  'github.copilot-chat',
  'agent-traces.db',
);

const defaultDeps: WindowsHostDiscoveryDeps = {
  readDir: (dirPath) => {
    try {
      return fs.readdirSync(dirPath);
    } catch {
      return undefined;
    }
  },
  fileMtimeMs: (filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return stat.isFile() ? stat.mtimeMs : undefined;
    } catch {
      return undefined;
    }
  },
};

/** Cached discovery result; re-scanned at most every {@link CACHE_TTL_MS}. */
const CACHE_TTL_MS = 30_000;
let cache: { at: number; result: WindowsHostDatabaseCandidate[] } | undefined;

/** Drop the discovery cache (test hook). */
export function resetWindowsHostDiscoveryCache(): void {
  cache = undefined;
}

/**
 * Find every Copilot `agent-traces.db` on the Windows host reachable through
 * `/mnt/c/Users`, sorted most-recently-modified first. Scans every Windows
 * user profile for both desktop VS Code variants. Never throws; an unlistable
 * mount (not WSL, masked drvfs) yields `[]`, which doubles as the "am I in
 * WSL with a host mount" detection.
 *
 * Results from the default (real I/O) deps are cached for a short interval;
 * injected deps always run fresh.
 */
export function findWindowsHostDatabases(
  deps: WindowsHostDiscoveryDeps = defaultDeps,
): WindowsHostDatabaseCandidate[] {
  const useCache = deps === defaultDeps;
  if (useCache && cache !== undefined && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.result;
  }

  const users = deps.readDir(WINDOWS_USERS_DIR) ?? [];
  const found: WindowsHostDatabaseCandidate[] = [];
  for (const user of users) {
    for (const variant of CODE_VARIANTS) {
      const candidate = path.posix.join(
        WINDOWS_USERS_DIR,
        user,
        'AppData',
        'Roaming',
        variant,
        DB_RELATIVE,
      );
      const mtimeMs = deps.fileMtimeMs(candidate);
      if (mtimeMs !== undefined) {
        found.push({ path: candidate, mtimeMs, user });
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (useCache) {
    cache = { at: Date.now(), result: found };
  }
  return found;
}
