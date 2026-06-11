import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { findWslDatabases, WslDatabaseCandidate } from './wslPaths';

/**
 * Resolution of the Copilot `agent-traces.db` location.
 *
 * Honors an explicit `agentObservability.sqlitePath` override, else
 * auto-detects the platform default for the `github.copilot-chat`
 * globalStorage directory, trying both the stable `Code` and the
 * `Code - Insiders` variants. Pure I/O check; opens nothing.
 *
 * WSL / remote support:
 * - When the extension itself runs inside WSL (or any Linux remote server),
 *   Copilot Chat writes under `~/.vscode-server/data` (or
 *   `~/.vscode-server-insiders/data`) instead of `~/.config/Code`, so those
 *   directories are additional Linux candidates (`server` / `serverInsiders`).
 * - When the extension runs on the Windows host but the user's Copilot
 *   activity happens in Remote-WSL windows, the database lives inside the
 *   distro. If no Windows-local database exists, distros are scanned over the
 *   `\\wsl.localhost` UNC share as a fallback (`wsl`).
 */

/** Which candidate matched, for diagnostics and view messaging. */
export type DatabaseSource =
  | 'override'
  | 'stable'
  | 'insiders'
  | 'server'
  | 'serverInsiders'
  | 'wsl'
  | 'none';

export interface DatabasePathResult {
  /** The resolved absolute path (the best candidate), or the override path. */
  path: string | undefined;
  /** Whether {@link path} exists on disk as a file. */
  exists: boolean;
  /** Which candidate produced {@link path}. */
  source: DatabaseSource;
}

/** Relative path of the DB inside a VS Code variant's User dir. */
const DB_RELATIVE = path.join(
  'User',
  'globalStorage',
  'github.copilot-chat',
  'agent-traces.db',
);

/**
 * Minimal config seam so this module is unit-testable without VS Code: any
 * object exposing the override getter works (the real `Configuration` class
 * satisfies it).
 */
export interface PathConfig {
  getSqlitePathOverride(): string | undefined;
}

/** Whether a path is a readable file, absent, or present-but-access-denied. */
export type PathKind = 'file' | 'absent' | 'denied';

/**
 * Host seam so resolution is unit-testable on any platform: tests inject a
 * fake; production uses {@link defaultEnvironment} (real process/os/fs plus
 * WSL discovery).
 */
export interface PathEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir(): string;
  statKind(candidate: string): PathKind;
  /** WSL-distro databases reachable over UNC, newest first (win32 only). */
  findWslDatabases(): WslDatabaseCandidate[];
}

const defaultEnvironment: PathEnvironment = {
  platform: process.platform,
  env: process.env,
  homedir: () => os.homedir(),
  statKind,
  findWslDatabases: () => findWslDatabases(),
};

/**
 * Resolve the database path.
 *
 * Order: explicit override → stable `Code` default → `Code - Insiders`
 * default → (Linux) `~/.vscode-server` / `~/.vscode-server-insiders` data
 * dirs → (Windows) newest database found inside a WSL distro. The first
 * candidate that exists wins; if none exist, the highest-priority *candidate
 * path* is returned with `exists:false` so callers can surface a helpful "not
 * found at X" message. When there is no candidate at all (unknown platform,
 * no home dir), returns `{ path: undefined, exists: false, source: 'none' }`.
 */
export function resolveDatabasePath(
  config: PathConfig,
  environment: PathEnvironment = defaultEnvironment,
): DatabasePathResult {
  const override = config.getSqlitePathOverride();
  if (override !== undefined && override.length > 0) {
    // 'denied' counts as exists:true so the permission error surfaces downstream
    // (the snapshot copy throws EACCES/EPERM, which the service maps to
    // reason:'permission' rather than the less precise 'missingDb').
    return {
      path: override,
      exists: environment.statKind(override) !== 'absent',
      source: 'override',
    };
  }

  const candidates = platformCandidates(environment);
  if (candidates.length === 0) {
    return { path: undefined, exists: false, source: 'none' };
  }

  // Prefer the first candidate that is a readable file.
  let denied: { path: string; source: DatabaseSource } | undefined;
  for (const candidate of candidates) {
    const kind = environment.statKind(candidate.path);
    if (kind === 'file') {
      return { path: candidate.path, exists: true, source: candidate.source };
    }
    if (kind === 'denied' && denied === undefined) {
      denied = candidate;
    }
  }

  // No host-local database. On Windows, fall back to scanning WSL distros —
  // Remote-WSL users' Copilot data lives distro-side under ~/.vscode-server.
  // A readable WSL database beats reporting a denied/absent local one.
  if (environment.platform === 'win32') {
    const wsl = environment.findWslDatabases();
    if (wsl.length > 0) {
      return { path: wsl[0].path, exists: true, source: 'wsl' };
    }
  }

  // No readable file, but a present-but-unreadable one exists: surface it as
  // exists:true so the permission denial is reported precisely.
  if (denied !== undefined) {
    return { path: denied.path, exists: true, source: denied.source };
  }

  // None present — return the highest-priority candidate path for messaging.
  const first = candidates[0];
  return { path: first.path, exists: false, source: first.source };
}

/**
 * The ordered platform-default candidates: desktop VS Code variants first,
 * then (on Linux) the VS Code remote-server data dirs that Remote-WSL / SSH
 * extension hosts use for globalStorage.
 */
function platformCandidates(
  environment: PathEnvironment,
): Array<{ path: string; source: DatabaseSource }> {
  const candidates: Array<{ path: string; source: DatabaseSource }> = [];

  const stable = platformDbPath('Code', environment);
  if (stable !== undefined) {
    candidates.push({ path: stable, source: 'stable' });
  }
  const insiders = platformDbPath('Code - Insiders', environment);
  if (insiders !== undefined) {
    candidates.push({ path: insiders, source: 'insiders' });
  }

  if (environment.platform !== 'win32' && environment.platform !== 'darwin') {
    const home = environment.homedir();
    if (home.length > 0) {
      candidates.push({
        path: path.join(home, '.vscode-server', 'data', DB_RELATIVE),
        source: 'server',
      });
      candidates.push({
        path: path.join(home, '.vscode-server-insiders', 'data', DB_RELATIVE),
        source: 'serverInsiders',
      });
    }
  }

  return candidates;
}

/**
 * The platform-default `agent-traces.db` path for a given VS Code variant
 * directory name (`Code` or `Code - Insiders`), or `undefined` on an
 * unsupported platform / missing home dir.
 */
function platformDbPath(variant: string, environment: PathEnvironment): string | undefined {
  const base = userDataDir(variant, environment);
  if (base === undefined) {
    return undefined;
  }
  return path.join(base, DB_RELATIVE);
}

/** The per-user VS Code data directory for the current platform. */
function userDataDir(variant: string, environment: PathEnvironment): string | undefined {
  switch (environment.platform) {
    case 'win32': {
      const appData = environment.env.APPDATA;
      if (appData === undefined || appData.length === 0) {
        return undefined;
      }
      return path.join(appData, variant);
    }
    case 'darwin': {
      const home = environment.homedir();
      if (home.length === 0) {
        return undefined;
      }
      return path.join(home, 'Library', 'Application Support', variant);
    }
    default: {
      // Linux and other XDG-style platforms.
      const home = environment.homedir();
      if (home.length === 0) {
        return undefined;
      }
      const xdg = environment.env.XDG_CONFIG_HOME;
      const configBase = xdg !== undefined && xdg.length > 0 ? xdg : path.join(home, '.config');
      return path.join(configBase, variant);
    }
  }
}

/**
 * Classify a candidate path. A regular file is 'file'; ENOENT (and any other
 * "not there" outcome) is 'absent'; EACCES/EPERM is 'denied' (the file likely
 * exists but cannot be stat'd), which callers treat as present so the precise
 * permission error can surface when the snapshot copy is attempted.
 */
function statKind(candidate: string): PathKind {
  try {
    return fs.statSync(candidate).isFile() ? 'file' : 'absent';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'EACCES' || code === 'EPERM' ? 'denied' : 'absent';
  }
}
