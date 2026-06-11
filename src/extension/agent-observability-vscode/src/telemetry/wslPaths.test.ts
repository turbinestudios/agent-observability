import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { findWslDatabases, WslDiscoveryDeps } from './wslPaths';

/**
 * WSL distro database discovery over UNC, driven entirely through the injected
 * I/O seam (no real WSL needed). All expected paths use win32 separators —
 * UNC shares are a Windows-host concept.
 */

const DB_TAIL = path.win32.join(
  'data',
  'User',
  'globalStorage',
  'github.copilot-chat',
  'agent-traces.db',
);

function dbPath(root: string, home: string, variant: string): string {
  return path.win32.join(root, home, variant, DB_TAIL);
}

interface FakeWorld {
  distros: string[];
  /** Listable directories and their entries. Anything absent is unreadable. */
  dirs: Record<string, string[]>;
  /** Readable database files and their mtimes. */
  files: Record<string, number>;
}

function makeDeps(world: FakeWorld): WslDiscoveryDeps {
  return {
    listDistros: () => world.distros,
    readDir: (dirPath) => world.dirs[dirPath],
    fileMtimeMs: (filePath) => world.files[filePath],
  };
}

const UBUNTU = String.raw`\\wsl.localhost\Ubuntu`;
const DEBIAN_LEGACY = String.raw`\\wsl$\Debian`;

describe('findWslDatabases', () => {
  it('finds databases in user homes over \\\\wsl.localhost', () => {
    const found = findWslDatabases(
      makeDeps({
        distros: ['Ubuntu'],
        dirs: {
          [UBUNTU]: ['home', 'root', 'etc'],
          [path.win32.join(UBUNTU, 'home')]: ['martin'],
        },
        files: { [dbPath(UBUNTU, String.raw`home\martin`, '.vscode-server')]: 100 },
      }),
    );
    expect(found).toEqual([
      {
        path: dbPath(UBUNTU, String.raw`home\martin`, '.vscode-server'),
        mtimeMs: 100,
        distro: 'Ubuntu',
      },
    ]);
  });

  it('sorts results newest first across distros, users and server variants', () => {
    const oldStable = dbPath(UBUNTU, String.raw`home\a`, '.vscode-server');
    const newInsiders = dbPath(UBUNTU, String.raw`home\b`, '.vscode-server-insiders');
    const midRoot = dbPath(UBUNTU, 'root', '.vscode-server');
    const found = findWslDatabases(
      makeDeps({
        distros: ['Ubuntu'],
        dirs: {
          [UBUNTU]: ['home'],
          [path.win32.join(UBUNTU, 'home')]: ['a', 'b'],
        },
        files: { [oldStable]: 10, [newInsiders]: 30, [midRoot]: 20 },
      }),
    );
    expect(found.map((f) => f.path)).toEqual([newInsiders, midRoot, oldStable]);
  });

  it('falls back to the legacy \\\\wsl$ share when \\\\wsl.localhost is unreachable', () => {
    const legacyDb = dbPath(DEBIAN_LEGACY, String.raw`home\me`, '.vscode-server');
    const found = findWslDatabases(
      makeDeps({
        distros: ['Debian'],
        dirs: {
          // \\wsl.localhost\Debian is intentionally NOT listable.
          [DEBIAN_LEGACY]: ['home'],
          [path.win32.join(DEBIAN_LEGACY, 'home')]: ['me'],
        },
        files: { [legacyDb]: 5 },
      }),
    );
    expect(found).toEqual([{ path: legacyDb, mtimeMs: 5, distro: 'Debian' }]);
  });

  it('scans the root home even when /home is empty or unlistable', () => {
    const rootDb = dbPath(UBUNTU, 'root', '.vscode-server');
    const found = findWslDatabases(
      makeDeps({
        distros: ['Ubuntu'],
        dirs: { [UBUNTU]: ['root'] }, // 'home' not listable
        files: { [rootDb]: 7 },
      }),
    );
    expect(found).toEqual([{ path: rootDb, mtimeMs: 7, distro: 'Ubuntu' }]);
  });

  it('returns empty when there are no distros', () => {
    expect(findWslDatabases(makeDeps({ distros: [], dirs: {}, files: {} }))).toEqual([]);
  });

  it('returns empty when distro enumeration throws', () => {
    const deps: WslDiscoveryDeps = {
      listDistros: () => {
        throw new Error('wsl.exe missing');
      },
      readDir: () => undefined,
      fileMtimeMs: () => undefined,
    };
    expect(findWslDatabases(deps)).toEqual([]);
  });

  it('skips unreachable distros but keeps scanning the rest', () => {
    const ubuntuDb = dbPath(UBUNTU, String.raw`home\me`, '.vscode-server');
    const found = findWslDatabases(
      makeDeps({
        distros: ['Ghost', 'Ubuntu'],
        dirs: {
          [UBUNTU]: ['home'],
          [path.win32.join(UBUNTU, 'home')]: ['me'],
        },
        files: { [ubuntuDb]: 1 },
      }),
    );
    expect(found).toEqual([{ path: ubuntuDb, mtimeMs: 1, distro: 'Ubuntu' }]);
  });
});
