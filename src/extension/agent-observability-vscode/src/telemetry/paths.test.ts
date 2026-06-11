import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { resolveDatabasePath, PathConfig, PathEnvironment, PathKind } from './paths';
import { WslDatabaseCandidate } from './wslPaths';

/**
 * Database path resolution across platforms, including the WSL fallbacks:
 * server-side candidates when running inside WSL/remote (Linux), and UNC
 * distro scanning when running on the Windows host with no local database.
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
  /** What WSL discovery reports (newest first). */
  wsl?: WslDatabaseCandidate[];
}

function makeEnv(opts: EnvOptions): PathEnvironment & { findWslDatabases: ReturnType<typeof vi.fn> } {
  const files = new Set(opts.files ?? []);
  const denied = new Set(opts.denied ?? []);
  return {
    platform: opts.platform,
    env: opts.env ?? {},
    homedir: () => opts.home ?? '',
    statKind: (candidate: string): PathKind =>
      files.has(candidate) ? 'file' : denied.has(candidate) ? 'denied' : 'absent',
    findWslDatabases: vi.fn(() => opts.wsl ?? []),
  };
}

const LINUX_HOME = path.sep === '/' ? '/home/me' : 'C:\\fakehome\\me';
const APPDATA = path.join('C:', 'Users', 'me', 'AppData', 'Roaming');

const linuxDesktopDb = path.join(LINUX_HOME, '.config', 'Code', DB_RELATIVE);
const linuxServerDb = path.join(LINUX_HOME, '.vscode-server', 'data', DB_RELATIVE);
const linuxServerInsidersDb = path.join(LINUX_HOME, '.vscode-server-insiders', 'data', DB_RELATIVE);
const windowsStableDb = path.join(APPDATA, 'Code', DB_RELATIVE);

describe('resolveDatabasePath on Linux (covers inside-WSL extension host)', () => {
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
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: linuxDesktopDb, exists: true, source: 'stable' });
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

  it('never consults WSL discovery on Linux', () => {
    const env = makeEnv({ platform: 'linux', home: LINUX_HOME });
    resolveDatabasePath(makeConfig(), env);
    expect(env.findWslDatabases).not.toHaveBeenCalled();
  });

  it('returns source none when there is no home directory', () => {
    const env = makeEnv({ platform: 'linux', home: '' });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: undefined, exists: false, source: 'none' });
  });
});

describe('resolveDatabasePath on Windows with WSL fallback', () => {
  const wslDb: WslDatabaseCandidate = {
    path: String.raw`\\wsl.localhost\Ubuntu\home\me\.vscode-server\data` + path.win32.sep + DB_RELATIVE.split(path.sep).join(path.win32.sep),
    mtimeMs: 100,
    distro: 'Ubuntu',
  };

  it('does not consult WSL when a local database exists', () => {
    const env = makeEnv({
      platform: 'win32',
      env: { APPDATA },
      files: [windowsStableDb],
      wsl: [wslDb],
    });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: windowsStableDb, exists: true, source: 'stable' });
    expect(env.findWslDatabases).not.toHaveBeenCalled();
  });

  it('falls back to the newest WSL database when no local database exists', () => {
    const env = makeEnv({ platform: 'win32', env: { APPDATA }, wsl: [wslDb] });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: wslDb.path, exists: true, source: 'wsl' });
  });

  it('prefers a readable WSL database over a denied local one', () => {
    const env = makeEnv({
      platform: 'win32',
      env: { APPDATA },
      denied: [windowsStableDb],
      wsl: [wslDb],
    });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: wslDb.path, exists: true, source: 'wsl' });
  });

  it('still surfaces a denied local database when WSL has nothing', () => {
    const env = makeEnv({ platform: 'win32', env: { APPDATA }, denied: [windowsStableDb] });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: windowsStableDb, exists: true, source: 'stable' });
  });

  it('reports the local stable candidate as missing when WSL also has nothing', () => {
    const env = makeEnv({ platform: 'win32', env: { APPDATA } });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r).toEqual({ path: windowsStableDb, exists: false, source: 'stable' });
    expect(env.findWslDatabases).toHaveBeenCalledOnce();
  });
});

describe('resolveDatabasePath overrides and macOS', () => {
  it('an explicit override always wins, even when WSL data exists', () => {
    const override = path.join('D:', 'custom', 'agent-traces.db');
    const env = makeEnv({
      platform: 'win32',
      env: { APPDATA },
      files: [override],
      wsl: [{ path: 'x', mtimeMs: 1, distro: 'Ubuntu' }],
    });
    const r = resolveDatabasePath(makeConfig(override), env);
    expect(r).toEqual({ path: override, exists: true, source: 'override' });
    expect(env.findWslDatabases).not.toHaveBeenCalled();
  });

  it('never consults WSL discovery on macOS', () => {
    const env = makeEnv({ platform: 'darwin', home: LINUX_HOME });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r.source).toBe('stable');
    expect(r.exists).toBe(false);
    expect(env.findWslDatabases).not.toHaveBeenCalled();
  });

  it('does not add server candidates on macOS', () => {
    const serverDb = path.join(LINUX_HOME, '.vscode-server', 'data', DB_RELATIVE);
    const env = makeEnv({ platform: 'darwin', home: LINUX_HOME, files: [serverDb] });
    const r = resolveDatabasePath(makeConfig(), env);
    expect(r.exists).toBe(false);
  });
});
