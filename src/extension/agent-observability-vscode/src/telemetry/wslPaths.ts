import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';

/**
 * Discovery of Copilot `agent-traces.db` files inside WSL distros, for the
 * case where this extension runs on the Windows host while the user's Copilot
 * activity happens in Remote-WSL windows. There, Copilot Chat runs in the WSL
 * extension host and writes its globalStorage under the distro-side
 * `~/.vscode-server/data` (or `~/.vscode-server-insiders/data`) directory,
 * which Windows can read over the `\\wsl.localhost\<distro>` UNC share
 * (`\\wsl$\<distro>` on older Windows builds).
 *
 * Used by {@link ./paths.resolveDatabasePath} as a FALLBACK only — consulted
 * when no Windows-local database exists — so ordinary non-WSL users never pay
 * for a `wsl.exe` spawn. Results are cached briefly because the resolver runs
 * on every query.
 *
 * All paths here are built with `path.win32` explicitly: UNC shares are a
 * Windows-host concept regardless of where unit tests run.
 */

/** A database found inside a WSL distro, reachable over UNC. */
export interface WslDatabaseCandidate {
  /** Full UNC path to the `agent-traces.db` file. */
  path: string;
  /** Source-file mtime, used to prefer the most recently active install. */
  mtimeMs: number;
  /** Distro the file was found in, for diagnostics. */
  distro: string;
}

/**
 * I/O seam so discovery is unit-testable without WSL. Every operation is
 * total: errors are expressed as `undefined`/empty, never thrown.
 */
export interface WslDiscoveryDeps {
  /** Installed WSL distro names, or `[]` when WSL is unavailable. */
  listDistros(): string[];
  /** Entry names of a directory, or `undefined` when it cannot be listed. */
  readDir(dirPath: string): string[] | undefined;
  /** mtime (ms) when the path is a readable regular file, else `undefined`. */
  fileMtimeMs(filePath: string): number | undefined;
}

/** Server-variant directories the VS Code remote server installs into. */
const SERVER_VARIANTS = ['.vscode-server', '.vscode-server-insiders'];

/** DB location inside a server variant's data dir, mirroring paths.ts. */
const SERVER_DB_RELATIVE = path.win32.join(
  'data',
  'User',
  'globalStorage',
  'github.copilot-chat',
  'agent-traces.db',
);

/** UNC roots to try, newest naming first (`\\wsl$` predates 21H2). */
const UNC_PREFIXES = ['\\\\wsl.localhost', '\\\\wsl$'];

const defaultDeps: WslDiscoveryDeps = {
  listDistros: listDistrosViaWslExe,
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

/**
 * Run `wsl.exe --list --quiet` and parse the distro names. The output is
 * UTF-16LE (wsl.exe writes wide chars); a missing wsl.exe, a non-zero exit
 * (e.g. WSL installed but no distros) or a hang past the timeout all yield
 * `[]`.
 */
function listDistrosViaWslExe(): string[] {
  let raw: Buffer;
  try {
    raw = execFileSync('wsl.exe', ['--list', '--quiet'], {
      timeout: 3000,
      windowsHide: true,
    });
  } catch {
    return [];
  }
  // wsl.exe normally writes UTF-16LE; with WSL_UTF8=1 set it writes UTF-8.
  // UTF-16LE-encoded ASCII names always contain zero bytes, UTF-8 never does.
  const text = raw.includes(0) ? raw.toString('utf16le') : raw.toString('utf8');
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/\0/g, '').trim())
    .filter((line) => line.length > 0);
}

/** Cached discovery result; re-scanned at most every {@link CACHE_TTL_MS}. */
const CACHE_TTL_MS = 30_000;
let cache: { at: number; result: WslDatabaseCandidate[] } | undefined;

/** Drop the discovery cache (test hook). */
export function resetWslDiscoveryCache(): void {
  cache = undefined;
}

/**
 * Find every Copilot `agent-traces.db` reachable inside installed WSL distros,
 * sorted most-recently-modified first. Scans `\home\<user>` plus `\root` of
 * each distro for both server variants. Never throws; an unreachable distro or
 * share contributes nothing.
 *
 * Results from the default (real I/O) deps are cached for a short interval;
 * injected deps always run fresh.
 */
export function findWslDatabases(deps: WslDiscoveryDeps = defaultDeps): WslDatabaseCandidate[] {
  const useCache = deps === defaultDeps;
  if (useCache && cache !== undefined && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.result;
  }

  let distros: string[];
  try {
    distros = deps.listDistros();
  } catch {
    distros = [];
  }

  const found: WslDatabaseCandidate[] = [];
  for (const distro of distros) {
    const root = reachableDistroRoot(distro, deps);
    if (root === undefined) {
      continue;
    }
    for (const home of homeDirs(root, deps)) {
      for (const variant of SERVER_VARIANTS) {
        const candidate = path.win32.join(home, variant, SERVER_DB_RELATIVE);
        const mtimeMs = deps.fileMtimeMs(candidate);
        if (mtimeMs !== undefined) {
          found.push({ path: candidate, mtimeMs, distro });
        }
      }
    }
  }
  found.sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (useCache) {
    cache = { at: Date.now(), result: found };
  }
  return found;
}

/** The first UNC root of a distro that can actually be listed, if any. */
function reachableDistroRoot(distro: string, deps: WslDiscoveryDeps): string | undefined {
  for (const prefix of UNC_PREFIXES) {
    const root = `${prefix}\\${distro}`;
    if (deps.readDir(root) !== undefined) {
      return root;
    }
  }
  return undefined;
}

/** All user home directories of a distro: `\home\*` plus `\root`. */
function homeDirs(root: string, deps: WslDiscoveryDeps): string[] {
  const users = deps.readDir(path.win32.join(root, 'home')) ?? [];
  const homes = users.map((user) => path.win32.join(root, 'home', user));
  homes.push(path.win32.join(root, 'root'));
  return homes;
}
