import { describe, it, expect, afterEach } from 'vitest';
import { Database } from 'node-sqlite3-wasm';
import { ensureSnapshotIndexes, TelemetryDatabase } from './database';
import { copyFixtureToTemp } from './testSupport';
import { IngestStore } from '../otel/ingestStore';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const INDEX = 'idx_span_attributes_key';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) {
    cleanups.pop()?.();
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agent-obs-idx-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Names of the indexes SQLite knows about, read through a fresh connection. */
function indexNames(dbPath: string): string[] {
  const db = new Database(dbPath, { readOnly: true, fileMustExist: true });
  try {
    const rows = db.all("SELECT name FROM sqlite_master WHERE type = 'index'") as { name: string }[];
    return rows.map((r) => r.name);
  } finally {
    db.close();
  }
}

/** The plan SQLite chooses for a lookup keyed by `key` alone. */
function keyLookupPlan(dbPath: string): string {
  const db = new Database(dbPath, { readOnly: true, fileMustExist: true });
  try {
    const rows = db.all(
      "EXPLAIN QUERY PLAN SELECT span_id FROM span_attributes WHERE key = 'copilot_chat.mode_name'",
    ) as { detail: string }[];
    return rows.map((r) => r.detail).join(' | ');
  } finally {
    db.close();
  }
}

describe('IngestStore read-layer indexes', () => {
  it('creates the span_attributes(key) index on a new store', () => {
    const dbPath = path.join(tempDir(), 'ingest.db');
    new IngestStore(dbPath).close();

    expect(indexNames(dbPath)).toContain(INDEX);
  });

  it('migrates a store that was written before the index existed', () => {
    const dbPath = path.join(tempDir(), 'ingest.db');
    const store = new IngestStore(dbPath);
    store.close();
    // Simulate the pre-index shape: drop it and confirm the scan comes back.
    const raw = new Database(dbPath);
    raw.exec(`DROP INDEX ${INDEX}`);
    raw.close();
    expect(indexNames(dbPath)).not.toContain(INDEX);

    // Merely re-opening the store is the migration.
    new IngestStore(dbPath).close();

    expect(indexNames(dbPath)).toContain(INDEX);
  });
});

describe('ensureSnapshotIndexes', () => {
  it('indexes a snapshot copy of a database it may not write, and the plan uses it', () => {
    const { dbPath } = copyFixtureToTemp();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));
    expect(indexNames(dbPath)).not.toContain(INDEX);
    expect(keyLookupPlan(dbPath)).toContain('SCAN');

    ensureSnapshotIndexes(dbPath);

    expect(indexNames(dbPath)).toContain(INDEX);
    expect(keyLookupPlan(dbPath)).toContain(INDEX);
  });

  it('is idempotent, so a re-snapshot never fails on an already-indexed copy', () => {
    const { dbPath } = copyFixtureToTemp();
    cleanups.push(() => rmSync(path.dirname(dbPath), { recursive: true, force: true }));

    ensureSnapshotIndexes(dbPath);
    expect(() => ensureSnapshotIndexes(dbPath)).not.toThrow();

    // Still a usable telemetry DB afterwards.
    const db = TelemetryDatabase.open(dbPath);
    db.close();
  });

  it('swallows a failure rather than blocking the open', () => {
    expect(() => ensureSnapshotIndexes(path.join(tempDir(), 'nope.db'))).not.toThrow();
  });
});
