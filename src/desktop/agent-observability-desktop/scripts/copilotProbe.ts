/**
 * Runs the Copilot indexer against the real database on this machine and
 * reports what it found and how long it took.
 *
 * The point of comparison is the extension, which cannot open that file at all
 * and copies it first — 300 MB here, on every refresh where the mtime moved.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { resolveDatabasePaths } from '@agent-observability/core/src/telemetry/paths';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { CopilotIndexer } from '../src/datahost/indexer/copilotIndexer';
import { IndexDb } from '../src/datahost/indexer/indexDb';

const dbPath = path.join(os.tmpdir(), `ao-copilot-${process.pid}.db`);

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;
}

function mb(file: string | undefined): string {
  if (file === undefined || !fs.existsSync(file)) {
    return 'absent';
  }
  return `${(fs.statSync(file).size / 1024 / 1024).toFixed(0)} MB`;
}

function main(): void {
  cleanup();
  const config = new Configuration(new DesktopSettingsReader());

  console.log('Copilot databases on this machine:');
  console.log(`  archive: ${mb(resolveArchiveDbPath(config))}`);
  for (const found of resolveDatabasePaths(config).databases) {
    console.log(`  ${found.source}: ${mb(found.path)}  ${found.path}`);
  }
  console.log();

  const db = new IndexDb(dbPath);
  const started = process.hrtime.bigint();
  const result = new CopilotIndexer({ db, config }).run();
  const ms = Number(process.hrtime.bigint() - started) / 1e6;

  if (result.skipped !== undefined) {
    console.log(`skipped: ${result.skipped}`);
  }
  console.log(`indexed ${result.hydrated} of ${result.discovered} sessions in ${ms.toFixed(0)} ms`);
  console.log(`source: ${result.sourcePath ?? 'none'}\n`);

  // A second pass proves the title cache: nothing should be re-read.
  const again = process.hrtime.bigint();
  new CopilotIndexer({ db, config }).run();
  console.log(`second pass: ${(Number(process.hrtime.bigint() - again) / 1e6).toFixed(0)} ms\n`);

  const rows = db.listSessions({ source: 'copilot', limit: 5 });
  console.log(`sample rows (${db.countSessions({ source: 'copilot' })} total):`);
  for (const row of rows) {
    const title = (row.title ?? row.sessionId).slice(0, 46);
    console.log(`  ${title.padEnd(48)} ${String(row.interactionCount).padStart(5)} steps  ${row.repository}`);
  }

  const all = db.listSessions({ source: 'copilot', limit: 2000 });
  const withTitles = all.filter((r) => r.title !== undefined).length;
  const withRepo = all.filter((r) => r.repository !== 'unknown').length;
  console.log(`\ncoverage across all ${all.length} sessions:`);
  console.log(`  titles ....... ${withTitles} (${pct(withTitles, all.length)})`);
  console.log(`  repositories . ${withRepo} (${pct(withRepo, all.length)})`);
  console.log(`  titles known in index (any session): ${db.allTitles().size}`);

  // Nothing may be written next to Copilot's own database.
  const stray = result.sourcePath === undefined ? [] : ['-journal', '-wal2'].filter((s) => fs.existsSync(result.sourcePath + s));
  console.log(`stray files beside the source: ${stray.length === 0 ? 'none' : stray.join(', ')}`);

  db.close();
  cleanup();
}

main();
