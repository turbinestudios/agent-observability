import { describe, it, expect } from 'vitest';
import { findWindowsHostDatabases, WindowsHostDiscoveryDeps } from './windowsHostPaths';

/**
 * Windows-host database discovery from inside WSL via the /mnt/c drvfs mount.
 * Pure-deps tests: no real WSL or filesystem required.
 */

const DB_TAIL = 'User/globalStorage/github.copilot-chat/agent-traces.db';

function dbPath(user: string, variant: string): string {
  return `/mnt/c/Users/${user}/AppData/Roaming/${variant}/${DB_TAIL}`;
}

function makeDeps(opts: {
  /** Listable directories → entries. */
  dirs: Record<string, string[]>;
  /** Readable files → mtime. */
  files: Record<string, number>;
}): WindowsHostDiscoveryDeps {
  return {
    readDir: (dirPath) => opts.dirs[dirPath],
    fileMtimeMs: (filePath) => opts.files[filePath],
  };
}

describe('findWindowsHostDatabases', () => {
  it('finds databases for every Windows user and both Code variants', () => {
    const found = findWindowsHostDatabases(
      makeDeps({
        dirs: { '/mnt/c/Users': ['alice', 'bob', 'Public'] },
        files: {
          [dbPath('alice', 'Code')]: 100,
          [dbPath('alice', 'Code - Insiders')]: 50,
          [dbPath('bob', 'Code')]: 200,
        },
      }),
    );
    expect(found.map((f) => f.path)).toEqual([
      dbPath('bob', 'Code'),
      dbPath('alice', 'Code'),
      dbPath('alice', 'Code - Insiders'),
    ]);
    expect(found[0].user).toBe('bob');
    expect(found[0].mtimeMs).toBe(200);
  });

  it('sorts newest first', () => {
    const found = findWindowsHostDatabases(
      makeDeps({
        dirs: { '/mnt/c/Users': ['a', 'b'] },
        files: { [dbPath('a', 'Code')]: 1, [dbPath('b', 'Code')]: 2 },
      }),
    );
    expect(found.map((f) => f.mtimeMs)).toEqual([2, 1]);
  });

  it('returns [] when /mnt/c/Users is not listable (not WSL / no host mount)', () => {
    expect(findWindowsHostDatabases(makeDeps({ dirs: {}, files: {} }))).toEqual([]);
  });

  it('returns [] when no user has a database', () => {
    const found = findWindowsHostDatabases(
      makeDeps({ dirs: { '/mnt/c/Users': ['alice', 'Default', 'Public'] }, files: {} }),
    );
    expect(found).toEqual([]);
  });
});
