import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Test-only helpers (not shipped — `src/**` is excluded from the .vsix).
 *
 * Resolves the real sanitized fixture DB and copies it to a fresh temp path so
 * tests exercise the same snapshot/open code path as the extension and never
 * touch the checked-in fixture.
 */

/** Absolute path to the checked-in fixture DB. */
export const FIXTURE_DB = path.resolve(
  __dirname,
  '../../../../../tools/copilot-telemetry/fixtures/sample-agent-traces.db',
);

/** Absolute path to the shared aggregate-batch schema. */
export const AGGREGATE_SCHEMA = path.resolve(
  __dirname,
  '../../../../../schemas/aggregate-batch.schema.json',
);

/**
 * Copy the fixture DB (and any sidecars) to a fresh temp dir and return both the
 * copy path and a cleanup function. Tests open the COPY, never the original.
 */
export function copyFixtureToTemp(): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-test-'));
  const dest = path.join(dir, 'agent-traces.db');
  fs.copyFileSync(FIXTURE_DB, dest);
  for (const suffix of ['-wal', '-shm']) {
    const from = FIXTURE_DB + suffix;
    if (fs.existsSync(from)) {
      fs.copyFileSync(from, dest + suffix);
    }
  }
  return {
    dbPath: dest,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
