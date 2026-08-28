import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
  candidateDatabasePaths,
  resolveDatabasePath,
  resolveDatabasePaths,
  PathConfig,
  PathEnvironment,
  PathKind,
} from './paths';

/**
 * Database path resolution across platforms. Local databases only — each
 * environment sees only its own databases (stable, insiders, server variants).
 */

const DB_RELATIVE = path.join('User', 'globalStorage', 'github.copilot-chat', 'agent-traces.db');

function makeConfig(override?: string): PathConfig {
  return { getSqlitePathOverride: () => override };
}

interface EnvOptions {
  platform: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  home?: string;
  /** Paths that stat as readable files. */
  files?: string[];
  /** Paths that stat as present-but-denied. */
  denied?: string[];
  /** Subdirectory names per directory, for the variant-editor scan. */
  subdirs?: Record<string, string[]>;
}

function makeEnv(opts: EnvOptions): PathEnvironment {
  const files = new Set(opts.files ?? []);
  const denied = new Set(opts.denied ?? []);
  return {
    platform: opts.platform,
    env: opts.env ?? {},
    homedir: () => opts.home ?? '',
    statKind: (candidate: string): PathKind =>
      files.has(candidate) ? 'file' : denied.has(candidate) ? 'denied' : 'absent',
    ...(opts.subdirs === undefined
      ? {}
      : { listSubdirectories: (dir: string) => opts.subdirs?.[dir] ?? [] }),
  };
}

const LINUX_HOME = path.sep === '/' ? '/home/me' : 'C:\\fakehome\\me';
const APPDATA = path.join('C:', 'Users', 'me', 'AppData', 'Roaming');

const linuxDesktopDb = path.join(LINUX_HOME, '.config', 'Code', DB_RELATIVE);
const linuxServerDb = path.join(LINUX_HOME, '.vscode-server', 'data', DB_RELATIVE);
const linuxServerInsidersDb = path.join(LINUX_HOME, '.vscode-server-insiders', 'data', DB_RELATIVE);
const windowsStableDb = path.join(APPDATA, 'Code', DB_RELATIVE);

describe('resolveDatabasePath(s) on Linux (covers inside-WSL extension host)', () => {
  it('falls back to ~/.vscode-server when no desktop database exists', () => {
    const env = makeEnv({ platform: 'linux', home: LINUX_HOME, files: [linuxServerDb] });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: linuxServerDb, exists: true, source: 'server' });
  });

  it('falls back to ~/.vscode-server-insiders when only that exists', () => {
    const env = makeEnv({ platform: 'linux', home: LINUX_HOME, files: [linuxServerInsidersDb] });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: linuxServerInsidersDb, exists: true, source: 'serverInsiders' });
  });

  it('prefers the desktop database over the server one when both exist', () => {
    const env = makeEnv({
      platform: 'linux',
      home: LINUX_HOME,
      files: [linuxDesktopDb, linuxServerDb],
    });
    const r = resolveDatabasePaths(makeConfig(), env);
    expect(r.primary).toEqual({ path: linuxDesktopDb, exists: true, source: 'stable' });
    expect(r.databases).toEqual([
      { path: linuxDesktopDb, source: 'stable' },
      { path: linuxServerDb, source: 'server' },
    ]);
  });

  it('honors XDG_CONFIG_HOME for the desktop candidate', () => {
    const xdg = path.join(LINUX_HOME, 'xdg');
    const xdgDb = path.join(xdg, 'Code', DB_RELATIVE);
    const env = makeEnv({
      platform: 'linux',
      home: LINUX_HOME,
      env: { XDG_CONFIG_HOME: xdg },
      files: [xdgDb],
    });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: xdgDb, exists: true, source: 'stable' });
  });

  it('returns source none when there is no home directory', () => {
    const env = makeEnv({ platform: 'linux', home: '' });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: undefined, exists: false, source: 'none' });
  });
});

describe('resolveDatabasePath(s) on Windows', () => {
  it('finds the stable database', () => {
    const env = makeEnv({ platform: 'win32', env: { APPDATA }, files: [windowsStableDb] });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: windowsStableDb, exists: true, source: 'stable' });
  });

  it('still surfaces a denied local database', () => {
    const env = makeEnv({ platform: 'win32', env: { APPDATA }, denied: [windowsStableDb] });
    const r = resolveDatabasePaths(makeConfig(), env);
    expect(r.primary).toEqual({ path: windowsStableDb, exists: true, source: 'stable' });
    expect(r.databases).toEqual([]);
  });

  it('reports the local stable candidate as missing when nothing exists', () => {
    const env = makeEnv({ platform: 'win32', env: { APPDATA } });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: windowsStableDb, exists: false, source: 'stable' });
  });
});

describe('resolveDatabasePath(s) overrides and macOS', () => {
  it('an explicit override always wins and pins a SINGLE database', () => {
    const override = path.join('D:', 'custom', 'agent-traces.db');
    const env = makeEnv({
      platform: 'win32',
      env: { APPDATA },
      files: [override],
    });
    const r = resolveDatabasePaths(makeConfig(override), env);
    expect(r.primary).toEqual({ path: override, exists: true, source: 'override' });
    expect(r.databases).toEqual([{ path: override, source: 'override' }]);
  });

  it('a missing override yields no databases but keeps the override path for messaging', () => {
    const override = path.join('D:', 'custom', 'agent-traces.db');
    const env = makeEnv({ platform: 'win32', env: { APPDATA } });
    const r = resolveDatabasePaths(makeConfig(override), env);
    expect(r.primary).toEqual({ path: override, exists: false, source: 'override' });
    expect(r.databases).toEqual([]);
  });

  it('macOS uses platform defaults', () => {
    const env = makeEnv({ platform: 'darwin', home: LINUX_HOME });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r.source).toBe('stable');
    expect(r.exists).toBe(false);
  });

  it('does not add server candidates on macOS', () => {
    const serverDb = path.join(LINUX_HOME, '.vscode-server', 'data', DB_RELATIVE);
    const env = makeEnv({ platform: 'darwin', home: LINUX_HOME, files: [serverDb] });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r.exists).toBe(false);
  });
});

describe('variant-editor discovery', () => {
  const MAC_HOME = LINUX_HOME;
  const macRoot = path.join(MAC_HOME, 'Library', 'Application Support');
  const cursorDb = path.join(macRoot, 'Cursor', DB_RELATIVE);
  const codeDb = path.join(macRoot, 'Code', DB_RELATIVE);

  it('finds a Copilot database under a VS Code-derived editor (macOS Cursor)', () => {
    const env = makeEnv({
      platform: 'darwin',
      home: MAC_HOME,
      files: [cursorDb],
      subdirs: { [macRoot]: ['Cursor', 'Firefox', 'Slack'] },
    });
    const r = resolveDatabasePaths(makeConfig(), env);
    expect(r.primary).toEqual({ path: cursorDb, exists: true, source: 'variant' });
    expect(r.databases).toEqual([{ path: cursorDb, source: 'variant' }]);
  });

  it('ranks named VS Code candidates ahead of discovered variants', () => {
    const env = makeEnv({
      platform: 'darwin',
      home: MAC_HOME,
      files: [cursorDb, codeDb],
      subdirs: { [macRoot]: ['Code', 'Cursor'] },
    });
    const r = resolveDatabasePaths(makeConfig(), env);
    expect(r.databases).toEqual([
      { path: codeDb, source: 'stable' },
      { path: cursorDb, source: 'variant' },
    ]);
  });

  it('does not duplicate the Code directories the named candidates already cover', () => {
    const env = makeEnv({
      platform: 'darwin',
      home: MAC_HOME,
      files: [codeDb],
      subdirs: { [macRoot]: ['Code', 'Code - Insiders'] },
    });
    const r = resolveDatabasePaths(makeConfig(), env);
    expect(r.databases).toEqual([{ path: codeDb, source: 'stable' }]);
  });

  it('scans %APPDATA% siblings on Windows', () => {
    const codiumDb = path.join(APPDATA, 'VSCodium', DB_RELATIVE);
    const env = makeEnv({
      platform: 'win32',
      env: { APPDATA },
      files: [codiumDb],
      subdirs: { [APPDATA]: ['VSCodium'] },
    });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: codiumDb, exists: true, source: 'variant' });
  });

  it('skips the scan when the environment cannot list directories', () => {
    // No `subdirs` -> the fake has no listSubdirectories, like older seams.
    const env = makeEnv({ platform: 'darwin', home: MAC_HOME, files: [cursorDb] });
    const r = resolveDatabasePaths(makeConfig(), env);
    expect(r.databases).toEqual([]);
  });
});

describe('candidateDatabasePaths', () => {
  it('returns every platform candidate even when no database file exists', () => {
    // Title stores can outlive the rolling telemetry DB, so candidates must
    // not be gated on the DB file's existence (statKind is 'absent' for all).
    const env = makeEnv({ platform: 'linux', home: LINUX_HOME });
    expect(candidateDatabasePaths(makeConfig(), env)).toEqual([
      linuxDesktopDb,
      path.join(LINUX_HOME, '.config', 'Code - Insiders', DB_RELATIVE),
      linuxServerDb,
      linuxServerInsidersDb,
    ]);
  });

  it('an explicit override is the sole candidate, existing or not', () => {
    const override = path.join('D:', 'custom', 'agent-traces.db');
    const env = makeEnv({ platform: 'win32', env: { APPDATA } });
    expect(candidateDatabasePaths(makeConfig(override), env)).toEqual([override]);
  });

  it('returns no candidates when the platform yields none', () => {
    const env = makeEnv({ platform: 'win32', env: {} }); // no APPDATA
    expect(candidateDatabasePaths(makeConfig(), env)).toEqual([]);
  });
});
