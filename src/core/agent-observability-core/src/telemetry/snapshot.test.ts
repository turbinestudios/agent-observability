import { describe, it, expect } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createRequire } from 'node:module';
import { Database } from 'node-sqlite3-wasm';

// node:sqlite is a recent built-in not yet in Vite's known-builtins list, so a
// static `import ... from 'node:sqlite'` fails to resolve under vitest. Load it
// through createRequire (a real Node require) to sidestep the bundler resolver.
const { DatabaseSync } = createRequire(__filename)('node:sqlite') as {
  DatabaseSync: new (path: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...params: unknown[]): unknown };
    close(): void;
  };
};
import { SNAPSHOT_DIR_PREFIX, createReadonlySnapshot, sweepSnapshotDirs } from './snapshot';
import { TelemetryDatabase } from './database';
import { TelemetryService, ServiceConfig } from './telemetryService';
import { FIXTURE_DB } from './testSupport';

/**
 * Snapshot journal-mode normalization. Copilot keeps `agent-traces.db` in WAL
 * mode, but the bundled node-sqlite3-wasm driver has no WAL VFS and cannot open
 * a WAL-flagged file. {@link createReadonlySnapshot} rewrites the COPY's header
 * to rollback-journal and folds any committed `-wal` frames into the COPY so the
 * reader sees the latest committed state — never waiting for Copilot to
 * checkpoint, and never touching the original file.
 */

const HEADER_WRITE_VERSION_OFFSET = 18;
const HEADER_READ_VERSION_OFFSET = 19;
const SQLITE_VERSION_WAL = 2;
const SQLITE_VERSION_ROLLBACK = 1;

/** Read header bytes 18,19 (the file-format write/read version) of a db file. */
function headerVersions(dbPath: string): [number, number] {
  const fd = fs.openSync(dbPath, 'r');
  try {
    const header = Buffer.alloc(20);
    fs.readSync(fd, header, 0, header.length, 0);
    return [header[HEADER_WRITE_VERSION_OFFSET], header[HEADER_READ_VERSION_OFFSET]];
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Copy the rollback-journal fixture to a fresh temp dir and flip its header to
 * WAL mode (version bytes -> 2), simulating Copilot's live `agent-traces.db`
 * without needing a WAL-capable writer. Returns the source path + cleanup.
 */
function makeWalFlaggedSource(): { dbPath: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-wal-'));
  const dbPath = path.join(dir, 'agent-traces.db');
  fs.copyFileSync(FIXTURE_DB, dbPath);
  const fd = fs.openSync(dbPath, 'r+');
  try {
    const wal = Buffer.from([SQLITE_VERSION_WAL, SQLITE_VERSION_WAL]);
    fs.writeSync(fd, wal, 0, wal.length, HEADER_WRITE_VERSION_OFFSET);
  } finally {
    fs.closeSync(fd);
  }
  return { dbPath, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Build a genuine WAL-mode database with `rowCount` rows that live ONLY in the
 * `-wal` sidecar (autocheckpoint off + the writer kept open, so nothing is
 * checkpointed into the main file). Uses Node's built-in WAL-capable driver to
 * write; the snapshot path must replay those frames for the rows to be visible.
 * Call `close()` after the snapshot is taken, then `cleanup()`.
 */
function makeRealWalSource(rowCount: number): {
  dbPath: string;
  close: () => void;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-realwal-'));
  const dbPath = path.join(dir, 'agent-traces.db');
  const writer = new DatabaseSync(dbPath);
  writer.exec('PRAGMA journal_mode=WAL');
  writer.exec('PRAGMA wal_autocheckpoint=0'); // never fold frames back automatically
  writer.exec('CREATE TABLE t (x INTEGER)');
  const stmt = writer.prepare('INSERT INTO t (x) VALUES (?)');
  for (let i = 0; i < rowCount; i++) {
    stmt.run(i);
  }
  // Keep `writer` open: closing would checkpoint and empty the -wal.
  return {
    dbPath,
    close: () => writer.close(),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function makeConfig(override: string): ServiceConfig {
  return {
    isLocalTelemetryEnabled: () => true,
    getSqlitePathOverride: () => override,
    getCodeFileExtensions: () => [],
    getDocFileExtensions: () => [],
  };
}

describe('createReadonlySnapshot journal-mode normalization', () => {
  it('rewrites a checkpointed WAL db (no -wal) to rollback so it opens', () => {
    const src = makeWalFlaggedSource();
    // Sanity: the source really is flagged WAL.
    expect(headerVersions(src.dbPath)).toEqual([SQLITE_VERSION_WAL, SQLITE_VERSION_WAL]);

    const snap = createReadonlySnapshot(src.dbPath);
    try {
      // The COPY was normalized to rollback-journal...
      expect(headerVersions(snap.dbPath)).toEqual([
        SQLITE_VERSION_ROLLBACK,
        SQLITE_VERSION_ROLLBACK,
      ]);
      // ...and is now openable + schema-valid via the real reader.
      const db = TelemetryDatabase.open(snap.dbPath);
      expect(db.getOverviewMetrics().totalInteractions).toBe(429);
      db.close();
      // The original source is untouched (still WAL-flagged).
      expect(headerVersions(src.dbPath)).toEqual([SQLITE_VERSION_WAL, SQLITE_VERSION_WAL]);
    } finally {
      snap.dispose();
      src.cleanup();
    }
  });

  it('replays committed WAL frames so -wal-only rows are visible in the copy', () => {
    const src = makeRealWalSource(7);
    try {
      // Sanity: the rows live only in the -wal (the main file is not checkpointed).
      expect(fs.statSync(src.dbPath + '-wal').size).toBeGreaterThan(32);
      expect(headerVersions(src.dbPath)).toEqual([SQLITE_VERSION_WAL, SQLITE_VERSION_WAL]);

      const snap = createReadonlySnapshot(src.dbPath);
      try {
        // The copy is now rollback-journal and openable by the bundled driver.
        expect(headerVersions(snap.dbPath)).toEqual([
          SQLITE_VERSION_ROLLBACK,
          SQLITE_VERSION_ROLLBACK,
        ]);
        const db = new Database(snap.dbPath, { readOnly: true, fileMustExist: true });
        try {
          const row = db.get('SELECT COUNT(*) AS n FROM t') as { n: number } | null;
          // Without replay the table would not even exist in the main file.
          expect(row?.n).toBe(7);
        } finally {
          db.close();
        }
      } finally {
        snap.dispose();
      }
    } finally {
      src.close();
      src.cleanup();
    }
  });

  it('falls back to the main file when the -wal is unrecognized (bad magic)', () => {
    const src = makeWalFlaggedSource();
    // A non-WAL sidecar (zeros) has no valid magic/frames: read the main file.
    fs.writeFileSync(src.dbPath + '-wal', Buffer.alloc(64));
    try {
      const snap = createReadonlySnapshot(src.dbPath);
      try {
        const db = TelemetryDatabase.open(snap.dbPath);
        expect(db.getOverviewMetrics().totalInteractions).toBe(429);
        db.close();
      } finally {
        snap.dispose();
      }
    } finally {
      src.cleanup();
    }
  });

  it('leaves a rollback-journal db header untouched (no-op)', () => {
    // The checked-in fixture is a normal rollback-journal db.
    expect(headerVersions(FIXTURE_DB)).toEqual([
      SQLITE_VERSION_ROLLBACK,
      SQLITE_VERSION_ROLLBACK,
    ]);
    const snap = createReadonlySnapshot(FIXTURE_DB);
    try {
      expect(headerVersions(snap.dbPath)).toEqual([
        SQLITE_VERSION_ROLLBACK,
        SQLITE_VERSION_ROLLBACK,
      ]);
    } finally {
      snap.dispose();
    }
  });
});

describe('TelemetryService over a WAL-flagged source', () => {
  it('reads successfully instead of getting stuck on a "writing" state', () => {
    const src = makeWalFlaggedSource();
    const svc = new TelemetryService(makeConfig(src.dbPath));
    try {
      const r = svc.getOverview();
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.totalInteractions).toBe(429);
      }
    } finally {
      svc.dispose();
      src.cleanup();
    }
  });
});

describe('snapshot housekeeping', () => {
  it('creates the snapshot under a caller-supplied root, and dispose removes it', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-root-'));
    try {
      const snapshot = createReadonlySnapshot(FIXTURE_DB, { root });
      expect(snapshot.dbPath.startsWith(root)).toBe(true);
      expect(path.basename(path.dirname(snapshot.dbPath)).startsWith(SNAPSHOT_DIR_PREFIX)).toBe(true);
      snapshot.dispose();
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses with a plain sentence when the disk lacks room, creating nothing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-root-'));
    try {
      expect(() => createReadonlySnapshot(FIXTURE_DB, { root, diskFree: () => 1024 })).toThrow(
        /free disk space/,
      );
      // A refused snapshot must not leave a dir behind either.
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sweeps leftover snapshot dirs and nothing else', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-root-'));
    try {
      for (const name of ['agent-obs-a', 'agent-obs-b', 'unrelated-dir']) {
        fs.mkdirSync(path.join(root, name));
        fs.writeFileSync(path.join(root, name, 'agent-traces.db'), 'x');
      }
      // A stray FILE with the prefix is not a snapshot dir and is left alone.
      fs.writeFileSync(path.join(root, 'agent-obs-file'), 'x');

      expect(sweepSnapshotDirs(root)).toBe(2);
      expect(fs.readdirSync(root).sort()).toEqual(['agent-obs-file', 'unrelated-dir']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('an age gate spares fresh dirs — a concurrent process may still be copying', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-root-'));
    try {
      const old = path.join(root, 'agent-obs-old');
      const fresh = path.join(root, 'agent-obs-fresh');
      fs.mkdirSync(old);
      fs.mkdirSync(fresh);
      const twoHoursAgo = (Date.now() - 2 * 60 * 60_000) / 1000;
      fs.utimesSync(old, twoHoursAgo, twoHoursAgo);

      expect(sweepSnapshotDirs(root, 60 * 60_000)).toBe(1);
      expect(fs.readdirSync(root)).toEqual(['agent-obs-fresh']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sweeping a root that does not exist is a quiet no-op', () => {
    expect(sweepSnapshotDirs(path.join(os.tmpdir(), 'agent-obs-nope-nope'))).toBe(0);
  });
});
