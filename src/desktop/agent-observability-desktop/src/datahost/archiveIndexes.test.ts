import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import type { SettingsReader } from '@agent-observability/core/src/config/configuration';
import { ensureArchiveIndexes } from './archiveIndexes';

/**
 * Indexing the archive is an optimization, so the tests are mostly about what it
 * REFUSES to do: it must never write a database this app does not own, and must
 * never write while another process holds the archive's writer lease.
 */

const INDEX = 'idx_span_attributes_key';

let root: string;
let archive: string;
let foreign: string;

/** Copilot's schema, minus the read-layer index — i.e. the pre-fix shape. */
const SCHEMA = `
CREATE TABLE spans (span_id TEXT PRIMARY KEY, start_time_ms INTEGER NOT NULL);
CREATE TABLE span_attributes (
  span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT, PRIMARY KEY (span_id, key)
);`;

function makeDb(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec(SCHEMA);
  db.close();
}

function indexNames(file: string): string[] {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as {
      name: string;
    }[]).map((r) => r.name);
  } finally {
    db.close();
  }
}

function settings(values: Record<string, unknown>): SettingsReader {
  return {
    get: <T>(key: string, defaultValue: T): T => (values[key] as T) ?? defaultValue,
    onDidChange: () => ({ dispose: () => undefined }),
  };
}

function config(over: Record<string, unknown> = {}): Configuration {
  return new Configuration(
    settings({ 'localTelemetry.enabled': true, 'copilotArchive.path': archive, ...over }),
  );
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-arch-'));
  archive = path.join(root, 'copilot', 'agent-traces.db');
  foreign = path.join(root, 'globalStorage', 'agent-traces.db');
  makeDb(archive);
  makeDb(foreign);
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('ensureArchiveIndexes', () => {
  it('indexes this app\'s own archive', () => {
    expect(indexNames(archive)).not.toContain(INDEX);

    expect(ensureArchiveIndexes(config())).toBeUndefined();

    expect(indexNames(archive)).toContain(INDEX);
  });

  it('is a no-op on an archive that already has the index', () => {
    ensureArchiveIndexes(config());
    expect(ensureArchiveIndexes(config())).toBeUndefined();
    expect(indexNames(archive)).toContain(INDEX);
  });

  it('never writes a database this app does not own', () => {
    // No archive on this machine — the picked source is Copilot's own file.
    const cfg = config({
      'copilotArchive.path': path.join(root, 'absent.db'),
      sqlitePath: foreign,
    });

    expect(ensureArchiveIndexes(cfg)).toBeUndefined();

    expect(indexNames(foreign)).not.toContain(INDEX);
  });

  it('leaves the archive alone while another process holds the writer lease', () => {
    fs.writeFileSync(
      path.join(path.dirname(archive), 'writer.lock'),
      JSON.stringify({ pid: 1, host: 'other', ts: Date.now() }),
    );

    expect(ensureArchiveIndexes(config())).toBeUndefined();

    expect(indexNames(archive)).not.toContain(INDEX);
  });

  it('releases the lease so the archiver can take it back', () => {
    ensureArchiveIndexes(config());

    expect(fs.existsSync(path.join(path.dirname(archive), 'writer.lock'))).toBe(false);
  });

  it('reports a failure as a note instead of throwing', () => {
    fs.rmSync(archive);
    fs.writeFileSync(archive, 'not a database');

    expect(ensureArchiveIndexes(config())).toMatch(/could not index the archive/);
  });
});
