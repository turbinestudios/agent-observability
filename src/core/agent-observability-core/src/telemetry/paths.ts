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
 * - Every OTHER app directory beside `Code` in the platform's config root is
 *   scanned for the same `User/globalStorage/github.copilot-chat/` layout
 *   (`variant`), so VS Code-derived editors — Cursor, VSCodium, Windsurf, a
 *   portable build with its own data dir name — are found without anyone
 *   maintaining a list of them.
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
  | 'variant'
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
  /**
   * Names of the subdirectories of `dir` (empty on any error). Optional so
   * existing test fakes keep working; without it, variant-editor discovery is
   * simply skipped.
   */
  listSubdirectories?(dir: string): string[];
  /**
   * Whether `dir` exists as a directory (false on any error). Optional like
   * {@link listSubdirectories}; needed because {@link statKind} classifies
   * directories as 'absent'. Without it, editor-existence evidence falls back
   * to file stats alone.
   */
  directoryExists?(dir: string): boolean;
}

const defaultEnvironment: PathEnvironment = {
  platform: process.platform,
  env: process.env,
  homedir: () => os.homedir(),
  statKind,
  listSubdirectories: (dir: string): string[] => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  },
  directoryExists: (dir: string): boolean => {
    try {
      return fs.statSync(dir).isDirectory();
    } catch {
      return false;
    }
  },
};

/**
 * Resolve every reachable database local to the current environment.
 *
 * Order: explicit override (sole result) → stable `Code` default → `Code -
 * Insiders` default → (Linux) `~/.vscode-server` / `~/.vscode-server-insiders`
 * data dirs → any other config-root app directory with the Copilot layout
 * (variant editors). ALL readable candidates are returned (`databases`);
 * `primary` carries the messaging fallback when none exist.
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

  const candidates = [...platformCandidates(environment), ...variantCandidates(environment)];

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
 *
 * Deliberately EXCLUDES the variant-editor scan: this list is also what the
 * desktop Settings page shows as "locations checked", and enumerating every
 * app directory would drown the two paths a user can act on. Variant DBs that
 * actually exist still surface through {@link resolveDatabasePaths}.
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

/** One VS Code-family editor install the environment has concrete evidence of. */
export interface CopilotConfigTarget {
  /** Directory name under the config root: 'Code', 'Code - Insiders', 'Cursor', … */
  variant: string;
  /** 'stable' | 'insiders' | 'variant', for diagnostics. */
  source: DatabaseSource;
  /** Absolute `<configRoot>/<variant>/User` directory. */
  userDir: string;
  /** Absolute `<userDir>/settings.json` — may not exist yet. */
  settingsFile: string;
  /** Absolute path `agent-traces.db` would appear at for this editor. */
  dbPath: string;
  /** Current on-disk state of that DB. */
  dbKind: PathKind;
}

/**
 * The editors whose `User/settings.json` could carry the Copilot trace-exporter
 * setting (`github.copilot.chat.otel.dbSpanExporter.enabled`), with evidence
 * the editor actually exists:
 *
 * - `Code` / `Code - Insiders` qualify with any sign of an install (an
 *   existing settings.json, or the User dir itself — a fresh install with no
 *   settings file yet is exactly the case a caller can fix by creating one).
 * - Discovered variants (Cursor, VSCodium, Windsurf, …) qualify only with
 *   Copilot-specific evidence — a `github.copilot-chat` globalStorage dir or
 *   the trace DB itself — because the config root is full of non-editor app
 *   dirs that must never be offered a settings write.
 * - The Linux `~/.vscode-server*` data dirs are deliberately excluded: in
 *   remote setups the user-level settings.json lives on the client, and the
 *   server's `data/Machine/settings.json` has different semantics.
 */
export function copilotConfigTargets(
  environment: PathEnvironment = defaultEnvironment,
): CopilotConfigTarget[] {
  const root = configRoot(environment);
  if (root === undefined) {
    return [];
  }

  const build = (variant: string, source: DatabaseSource): CopilotConfigTarget => {
    const userDir = path.join(root, variant, 'User');
    return {
      variant,
      source,
      userDir,
      settingsFile: path.join(userDir, 'settings.json'),
      dbPath: path.join(root, variant, DB_RELATIVE),
      dbKind: environment.statKind(path.join(root, variant, DB_RELATIVE)),
    };
  };

  const targets: CopilotConfigTarget[] = [];

  for (const [variant, source] of [
    ['Code', 'stable'],
    ['Code - Insiders', 'insiders'],
  ] as const) {
    const target = build(variant, source);
    const evidence =
      environment.statKind(target.settingsFile) === 'file' ||
      environment.directoryExists?.(target.userDir) === true;
    if (evidence) {
      targets.push(target);
    }
  }

  const names = environment.listSubdirectories?.(root) ?? [];
  for (const variant of names
    .filter((name) => name !== 'Code' && name !== 'Code - Insiders')
    .sort()) {
    const target = build(variant, 'variant');
    const copilotDir = path.join(target.userDir, 'globalStorage', 'github.copilot-chat');
    const evidence =
      environment.directoryExists?.(copilotDir) === true || target.dbKind !== 'absent';
    if (evidence) {
      targets.push(target);
    }
  }

  return targets;
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
 * Candidates from OTHER apps in the config root that use VS Code's storage
 * layout: every subdirectory beside `Code` / `Code - Insiders` is a potential
 * VS Code-derived editor (Cursor, VSCodium, Windsurf, …), and if it has ever
 * run Copilot Chat it holds the same `User/globalStorage/github.copilot-chat/`
 * tree. Enumerating beats a hardcoded list of editor names: the caller stats
 * each candidate anyway, so a config root of N apps costs one readdir plus N
 * stats per refresh. Sorted for a deterministic scan order.
 */
function variantCandidates(
  environment: PathEnvironment,
): Array<{ path: string; source: DatabaseSource }> {
  const root = configRoot(environment);
  if (root === undefined || environment.listSubdirectories === undefined) {
    return [];
  }
  return environment
    .listSubdirectories(root)
    .filter((name) => name !== 'Code' && name !== 'Code - Insiders')
    .sort()
    .map((name) => ({ path: path.join(root, name, DB_RELATIVE), source: 'variant' as const }));
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
  const root = configRoot(environment);
  return root === undefined ? undefined : path.join(root, variant);
}

/**
 * The platform directory that holds every app's per-user data dir — the parent
 * of VS Code's `Code`, Cursor's `Cursor`, and so on.
 */
function configRoot(environment: PathEnvironment): string | undefined {
  switch (environment.platform) {
    case 'win32': {
      const appData = environment.env.APPDATA;
      if (appData === undefined || appData.length === 0) {
        return undefined;
      }
      return appData;
    }
    case 'darwin': {
      const home = environment.homedir();
      if (home.length === 0) {
        return undefined;
      }
      return path.join(home, 'Library', 'Application Support');
    }
    default: {
      // Linux and other XDG-style platforms.
      const home = environment.homedir();
      if (home.length === 0) {
        return undefined;
      }
      const xdg = environment.env.XDG_CONFIG_HOME;
      return xdg !== undefined && xdg.length > 0 ? xdg : path.join(home, '.config');
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
