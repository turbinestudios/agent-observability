import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { IngestStore, IngestHotJournalError } from './ingestStore';

/**
 * The bundled `node-sqlite3-wasm` driver must never be allowed to roll back a
 * hot journal.
 *
 * Measured against the real wedged ingest DB (2 GB, 15.9 MB hot journal): the
 * native driver recovers it to 17609 spans / 359116 attributes with
 * `integrity_check` = ok, while the WASM driver yields 17387 / 321263 and a
 * CORRUPT b-tree — silently, reporting success and accepting further writes.
 * So the store refuses to open rather than "recovering" into a wreck.
 */

/** SQLite's hot-journal magic. */
const HOT = Buffer.from([0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7]);

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-ingest-'));
  dbPath = path.join(dir, 'agent-traces.db');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('IngestStore hot-journal guard', () => {
  it('opens normally when no journal is present', () => {
    const store = new IngestStore(dbPath);
    expect(store.dbPath).toBe(dbPath);
    store.close();
  });

  it('refuses to open when a hot journal sits beside the database', () => {
    const store = new IngestStore(dbPath);
    store.close();
    fs.writeFileSync(`${dbPath}-journal`, Buffer.concat([HOT, Buffer.alloc(512)]));

    expect(() => new IngestStore(dbPath)).toThrow(IngestHotJournalError);
  });

  it('names the journal path in the error so the fix is actionable', () => {
    const store = new IngestStore(dbPath);
    store.close();
    fs.writeFileSync(`${dbPath}-journal`, Buffer.concat([HOT, Buffer.alloc(512)]));

    try {
      // eslint-disable-next-line no-new
      new IngestStore(dbPath);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(IngestHotJournalError);
      expect((err as IngestHotJournalError).dbPath).toBe(dbPath);
      expect((err as Error).message).toContain('-journal');
    }
  });

  it('leaves the database untouched when it refuses', () => {
    const store = new IngestStore(dbPath);
    store.close();
    const before = fs.readFileSync(dbPath);
    fs.writeFileSync(`${dbPath}-journal`, Buffer.concat([HOT, Buffer.alloc(512)]));

    expect(() => new IngestStore(dbPath)).toThrow(IngestHotJournalError);
    expect(fs.readFileSync(dbPath).equals(before)).toBe(true);
    // The journal must survive too — a native recovery still needs its pages.
    expect(fs.existsSync(`${dbPath}-journal`)).toBe(true);
  });

  it('opens when a journal exists but is not hot (finalized/zeroed)', () => {
    const store = new IngestStore(dbPath);
    store.close();
    fs.writeFileSync(`${dbPath}-journal`, Buffer.alloc(512));

    const reopened = new IngestStore(dbPath);
    expect(reopened.dbPath).toBe(dbPath);
    reopened.close();
  });

  it('opens when the journal is shorter than the magic', () => {
    const store = new IngestStore(dbPath);
    store.close();
    fs.writeFileSync(`${dbPath}-journal`, HOT.subarray(0, 4));

    const reopened = new IngestStore(dbPath);
    expect(reopened.dbPath).toBe(dbPath);
    reopened.close();
  });
});
