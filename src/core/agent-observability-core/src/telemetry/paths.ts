import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Resolution of the Copilot `agent-traces.db` location(s).
 *
 * Honors an explicit `agentObservability.sqlitePath` override, else
 * auto-detects databases local to the current environment:
 *
 * - The platform default for the `github.copilot-chat` globalStorage
 *   directory, trying both the stable `Code` and the `Code - Insiders`
 *   variants.
 * - When the extension itself runs inside WSL (or any Linux remote server),
 *   Copilot Chat writes under `~/.vscode-server/data` (or
 *   `~/.vscode-server-insiders/data`) instead of `~/.config/Code`, so those
 *   directories are additional Linux candidates (`server` / `serverInsiders`).
 *
 * Every readable database local to this environment is returned and the
 * service layer merges them. Pure I/O checks; opens nothing.
 */

/** Which candidate matched, for diagnostics and view messaging. */
export type DatabaseSource =
  | 'override'
  | 'stable'
  | 'insiders'
  | 'server'
  | 'serverInsiders'
  | 'ingest'
  | 'none';

/** One readable database the resolver found. */
export interface ResolvedDatabase {
  /** Absolute path (native, UNC, or `/mnt/c/...` depending on the source). */
  path: string;
  /** Which candidate produced {@link path}. */
  source: DatabaseSource;
}

export interface DatabasePathResult {
  /** The resolved absolute path (the best candidate), or the override path. */
  path: string | undefined;
  /** Whether {@link path} exists on disk as a file. */
  exists: boolean;
  /** Which candidate produced {@link path}. */
  source: DatabaseSource;
}

/** The full multi-environment resolution. */
export interface DatabasePathsResult {
  /**
   * Every readable database, in priority order (host-local candidates first,
   * then cross-environment discoveries newest-first), deduplicated by path.
   * Empty when nothing readable exists anywhere.
   */
  databases: ResolvedDatabase[];
  /**
   * Single-path summary, used for messaging and by callers that only need the
   * primary database: the first entry of {@link databases} when any exist,
   * else the present-but-access-denied candidate (`exists: true` so the
   * permission error surfaces precisely), else the highest-priority candidate
   * path with `exists: false` for a helpful "not found at X" message.
   */
  primary: DatabasePathResult;
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
 * fake; production uses {@link defaultEnvironment} (real process/os/fs).
 */
export interface PathEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homedir(): string;
  statKind(candidate: string): PathKind;
}

const defaultEnvironment: PathEnvironment = {
  platform: process.platform,
  env: process.env,
  homedir: () => os.homedir(),
  statKind,
};

/**
 * Resolve every reachable database local to the current environment.
 *
 * Order: explicit override (sole result) → stable `Code` default → `Code -
 * Insiders` default → (Linux) `~/.vscode-server` / `~/.vscode-server-insiders`
 * data dirs. ALL readable candidates are returned (`databases`); `primary`
 * carries the messaging fallback when none exist.
 */
export function resolveDatabasePaths(
  config: PathConfig,
  environment: PathEnvironment = defaultEnvironment,
): DatabasePathsResult {
  const override = config.getSqlitePathOverride();
  if (override !== undefined && override.length > 0) {
    // 'denied' counts as exists:true so the permission error surfaces downstream
    // (the snapshot copy throws EACCES/EPERM, which the service maps to
    // reason:'permission' rather than the less precise 'missingDb').
    const exists = environment.statKind(override) !== 'absent';
    return {
      databases: exists ? [{ path: override, source: 'override' }] : [],
      primary: { path: override, exists, source: 'override' },
    };
  }

  const candidates = platformCandidates(environment);

  const databases: ResolvedDatabase[] = [];
  const seen = new Set<string>();
  let denied: { path: string; source: DatabaseSource } | undefined;
  for (const candidate of candidates) {
    const kind = environment.statKind(candidate.path);
    if (kind === 'file' && !seen.has(candidate.path)) {
      seen.add(candidate.path);
      databases.push(candidate);
    } else if (kind === 'denied' && denied === undefined) {
      denied = candidate;
    }
  }

  if (databases.length > 0) {
    const first = databases[0];
    return {
      databases,
      primary: { path: first.path, exists: true, source: first.source },
    };
  }

  // No readable file, but a present-but-unreadable one exists: surface it as
  // exists:true so the permission denial is reported precisely.
  if (denied !== undefined) {
    return {
      databases,
      primary: { path: denied.path, exists: true, source: denied.source },
    };
  }

  // None present — return the highest-priority candidate path for messaging.
  if (candidates.length > 0) {
    const first = candidates[0];
    return {
      databases,
      primary: { path: first.path, exists: false, source: first.source },
    };
  }
  return {
    databases,
    primary: { path: undefined, exists: false, source: 'none' },
  };
}

/**
 * Every native candidate DB path — the override as sole candidate when set,
 * else ALL platform candidates, WITHOUT checking on-disk existence. Used to
 * locate the sibling `workspaceStorage` session-title stores when telemetry is
 * read from a non-native source (the durable archive / live-ingest DB): a
 * title store can outlive its rolling telemetry DB, so the DB file's existence
 * must not gate title resolution.
 */
export function candidateDatabasePaths(
  config: PathConfig,
  environment: PathEnvironment = defaultEnvironment,
): string[] {
  const override = config.getSqlitePathOverride();
  if (override !== undefined && override.length > 0) {
    return [override];
  }
  return platformCandidates(environment).map((candidate) => candidate.path);
}

/**
 * Single-database view of {@link resolveDatabasePaths} (its `primary`), for
 * callers and tests that only need the best candidate.
 */
export function resolveDatabasePath(
  config: PathConfig,
  environment: PathEnvironment = defaultEnvironment,
): DatabasePathResult {
  return resolveDatabasePaths(config, environment).primary;
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
