import { describe, it, expect } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import * as fs from 'node:fs';
import { createReadonlySnapshot } from './snapshot';
import { TelemetryDatabase } from './database';
import { FIXTURE_DB, copyFixtureToTemp } from './testSupport';

/**
 * Safety contract: the connection is read-only and operating on a snapshot copy
 * never mutates the source file.
 */

describe('read-only safety', () => {
  it('opens the snapshot read-only — writes throw', () => {
    const copy = copyFixtureToTemp();
    try {
      const raw = new Database(copy.dbPath, { readOnly: true, fileMustExist: true });
      try {
        // A write against a readonly connection must throw.
        expect(() => raw.run('DELETE FROM spans')).toThrow();
        expect(() =>
          raw.run("INSERT INTO spans (span_id, trace_id, name, start_time_ms, end_time_ms, status_code) VALUES ('x','x','x',0,0,0)"),
        ).toThrow();
      } finally {
        raw.close();
      }
    } finally {
      copy.cleanup();
    }
  });

  it('a full read through the adapter never mutates the source file', () => {
    // Snapshot the (copied) source so we can compare the SOURCE before/after.
    const copy = copyFixtureToTemp();
    try {
      const before = fs.statSync(copy.dbPath);

      const snapshot = createReadonlySnapshot(copy.dbPath);
      try {
        const db = TelemetryDatabase.open(snapshot.dbPath);
        // Exercise every read path.
        db.getOverviewMetrics();
        db.listRepositories();
        const sessions = db.listSessions();
        if (sessions.length > 0) {
          db.getSessionInteractions(sessions[0].sessionId);
        }
        db.close();
      } finally {
        snapshot.dispose();
      }

      const after = fs.statSync(copy.dbPath);
      // Source size and mtime are unchanged — we operated only on the temp copy.
      expect(after.size).toBe(before.size);
      expect(after.mtimeMs).toBe(before.mtimeMs);
    } finally {
      copy.cleanup();
    }
  });

  it('the checked-in fixture itself is never opened or modified', () => {
    // We only ever copy the fixture; assert the canonical file is untouched by
    // a full snapshot+read cycle started from a copy.
    const before = fs.statSync(FIXTURE_DB);
    const copy = copyFixtureToTemp();
    try {
      const snapshot = createReadonlySnapshot(copy.dbPath);
      const db = TelemetryDatabase.open(snapshot.dbPath);
      db.getOverviewMetrics();
      db.close();
      snapshot.dispose();
    } finally {
      copy.cleanup();
    }
    const after = fs.statSync(FIXTURE_DB);
    expect(after.size).toBe(before.size);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('dispose removes the temp snapshot copy', () => {
    const copy = copyFixtureToTemp();
    try {
      const snapshot = createReadonlySnapshot(copy.dbPath);
      expect(fs.existsSync(snapshot.dbPath)).toBe(true);
      snapshot.dispose();
      expect(fs.existsSync(snapshot.dbPath)).toBe(false);
      // Idempotent.
      expect(() => snapshot.dispose()).not.toThrow();
    } finally {
      copy.cleanup();
    }
  });
});
