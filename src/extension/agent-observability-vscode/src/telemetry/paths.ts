import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Resolution of the Copilot `agent-traces.db` location.
 *
 * Honors an explicit `agentObservability.sqlitePath` override, else
 * auto-detects the platform default for the `github.copilot-chat`
 * globalStorage directory, trying both the stable `Code` and the
 * `Code - Insiders` variants. Pure I/O check; opens nothing.
 */

/** Which candidate matched, for diagnostics and view messaging. */
export type DatabaseSource = 'override' | 'stable' | 'insiders' | 'none';

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

/**
 * Resolve the database path.
 *
 * Order: explicit override → stable `Code` default → `Code - Insiders`
 * default. The first candidate that exists wins; if none exist, the highest-
 * priority *candidate path* is returned with `exists:false` so callers can
 * surface a helpful "not found at X" message. When there is no candidate at
 * all (unknown platform, no home dir), returns `{ path: undefined, exists:
 * false, source: 'none' }`.
 */
export function resolveDatabasePath(config: PathConfig): DatabasePathResult {
  const override = config.getSqlitePathOverride();
  if (override !== undefined && override.length > 0) {
    // 'denied' counts as exists:true so the permission error surfaces downstream
    // (the snapshot copy throws EACCES/EPERM, which the service maps to
    // reason:'permission' rather than the less precise 'missingDb').
    return {
      path: override,
      exists: statKind(override) !== 'absent',
      source: 'override',
    };
  }

  const stable = platformDbPath('Code');
  const insiders = platformDbPath('Code - Insiders');

  const candidates: Array<{ path: string; source: DatabaseSource }> = [];
  if (stable !== undefined) {
    candidates.push({ path: stable, source: 'stable' });
  }
  if (insiders !== undefined) {
    candidates.push({ path: insiders, source: 'insiders' });
  }

  if (candidates.length === 0) {
    return { path: undefined, exists: false, source: 'none' };
  }

  // Prefer the first candidate that is a readable file.
  let denied: { path: string; source: DatabaseSource } | undefined;
  for (const candidate of candidates) {
    const kind = statKind(candidate.path);
    if (kind === 'file') {
      return { path: candidate.path, exists: true, source: candidate.source };
    }
    if (kind === 'denied' && denied === undefined) {
      denied = candidate;
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
 * The platform-default `agent-traces.db` path for a given VS Code variant
 * directory name (`Code` or `Code - Insiders`), or `undefined` on an
 * unsupported platform / missing home dir.
 */
function platformDbPath(variant: string): string | undefined {
  const base = userDataDir(variant);
  if (base === undefined) {
    return undefined;
  }
  return path.join(base, DB_RELATIVE);
}

/** The per-user VS Code data directory for the current platform. */
function userDataDir(variant: string): string | undefined {
  switch (process.platform) {
    case 'win32': {
      const appData = process.env.APPDATA;
      if (appData === undefined || appData.length === 0) {
        return undefined;
      }
      return path.join(appData, variant);
    }
    case 'darwin': {
      const home = os.homedir();
      if (home.length === 0) {
        return undefined;
      }
      return path.join(home, 'Library', 'Application Support', variant);
    }
    default: {
      // Linux and other XDG-style platforms.
      const home = os.homedir();
      if (home.length === 0) {
        return undefined;
      }
      const xdg = process.env.XDG_CONFIG_HOME;
      const configBase = xdg !== undefined && xdg.length > 0 ? xdg : path.join(home, '.config');
      return path.join(configBase, variant);
    }
  }
}

/** Whether a path is a readable file, absent, or present-but-access-denied. */
type PathKind = 'file' | 'absent' | 'denied';

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
