import { describe, expect, it, vi } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { SchemaMismatchError, TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';
import type { ReadonlySqliteConnection } from './readBackend';

describe('host-supplied read connections', () => {
  it('accepts native-style undefined for a missing row without changing query results', () => {
    const fixture = copyFixtureToTemp();
    const raw = new Database(fixture.dbPath, { readOnly: true });
    const close = vi.fn(() => raw.close());
    const connection: ReadonlySqliteConnection = {
      get: (sql, params) => raw.get(sql, params) ?? undefined,
      all: (sql, params) => raw.all(sql, params),
      close,
    };
    const db = TelemetryDatabase.fromConnection(connection);
    try {
      expect(db.getOverviewMetrics().totalInteractions).toBe(429);
      expect(db.getSessionDetail('absent')).toBeUndefined();
    } finally {
      db.close();
      fixture.cleanup();
    }
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes a supplied connection when validation fails', () => {
    const close = vi.fn();
    const connection: ReadonlySqliteConnection = { get: () => undefined, all: () => [], close };
    expect(() => TelemetryDatabase.fromConnection(connection)).toThrow(SchemaMismatchError);
    expect(close).toHaveBeenCalledTimes(1);
  });
});