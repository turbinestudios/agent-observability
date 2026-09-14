import { describe, it, expect } from 'vitest';
import {
  TelemetryDatabase,
  SchemaMismatchError,
  TelemetryUnreadableError,
} from './database';
import type { ReadonlySqliteConnection } from './readBackend';

/**
 * A DB that cannot be OPENED is not a DB with a bad schema.
 *
 * Regression guard for a real five-day outage: a crash left a hot rollback
 * journal beside the ingest DB, every read-only open failed with
 * `SQLITE_CANTOPEN` (a read-only connection cannot roll a journal back), and
 * `validateSchema` relabelled that as "missing the schema_version table". The
 * UI then told the user their telemetry schema was unsupported — pointing at
 * the one thing that was never wrong (the file was schema v1 throughout) and
 * away from the lock they could actually clear.
 */

/** A connection whose every query fails the way a wedged/locked DB fails. */
function failingConnection(err: unknown): ReadonlySqliteConnection {
  return {
    get() {
      throw err;
    },
    all() {
      throw err;
    },
    close() {
      /* no-op */
    },
  };
}

/** A SQLite error carrying a driver `code`, as better-sqlite3 raises. */
function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

describe('validateSchema: unreadable vs. schema mismatch', () => {
  it.each([
    ['SQLITE_CANTOPEN', 'unable to open database file'],
    ['SQLITE_BUSY', 'database is locked'],
    ['SQLITE_READONLY', 'attempt to write a readonly database'],
    ['SQLITE_IOERR', 'disk I/O error'],
  ])('reports %s as unreadable, not a schema mismatch', (code, message) => {
    expect(() => TelemetryDatabase.fromConnection(failingConnection(codedError(code, message)))).toThrow(
      TelemetryUnreadableError,
    );
    expect(() => TelemetryDatabase.fromConnection(failingConnection(codedError(code, message)))).not.toThrow(
      SchemaMismatchError,
    );
  });

  it('classifies a bare wasm-driver lock error (no code) as unreadable', () => {
    // node-sqlite3-wasm throws a plain SQLite3Error with only a message, which
    // is exactly how the stale lock sidecar surfaced.
    const bare = new Error('database is locked');
    bare.name = 'SQLite3Error';
    expect(() => TelemetryDatabase.fromConnection(failingConnection(bare))).toThrow(
      TelemetryUnreadableError,
    );
  });

  it('still reports a genuinely absent schema_version table as a schema mismatch', () => {
    const noTable = codedError('SQLITE_ERROR', 'no such table: schema_version');
    expect(() => TelemetryDatabase.fromConnection(failingConnection(noTable))).toThrow(
      SchemaMismatchError,
    );
  });

  it('still reports a non-database file as a schema mismatch', () => {
    const notADb = codedError('SQLITE_NOTADB', 'file is not a database');
    expect(() => TelemetryDatabase.fromConnection(failingConnection(notADb))).toThrow(
      SchemaMismatchError,
    );
  });

  it('closes the connection when validation fails', () => {
    let closed = false;
    const conn: ReadonlySqliteConnection = {
      get() {
        throw codedError('SQLITE_CANTOPEN', 'unable to open database file');
      },
      all() {
        return [];
      },
      close() {
        closed = true;
      },
    };
    expect(() => TelemetryDatabase.fromConnection(conn)).toThrow(TelemetryUnreadableError);
    expect(closed).toBe(true);
  });

  it('carries the original driver error as the cause', () => {
    const original = codedError('SQLITE_CANTOPEN', 'unable to open database file');
    try {
      TelemetryDatabase.fromConnection(failingConnection(original));
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelemetryUnreadableError);
      expect((err as TelemetryUnreadableError).detail).toBe('unreadable');
      expect((err as { cause?: unknown }).cause).toBe(original);
    }
  });
});
