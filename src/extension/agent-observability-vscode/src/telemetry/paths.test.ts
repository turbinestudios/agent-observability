import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import {
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
