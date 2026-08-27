/**
 * Measures the two numbers this app is built around: how long a cold index
 * takes over a real transcript corpus, and how fast the list query is once the
 * index exists.
 *
 * Run against a scratch database so a benchmark never disturbs the real index:
 *   node scripts/benchmark.js [--db <path>] [--keep]
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { ClaudeIndexer } from '../src/datahost/indexer/claudeIndexer';
import { IndexDb } from '../src/datahost/indexer/indexDb';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const dbFlag = args.indexOf('--db');
const dbPath =
  dbFlag >= 0 && args[dbFlag + 1] !== undefined
    ? args[dbFlag + 1]
    : path.join(os.tmpdir(), `ao-bench-${process.pid}.db`);

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function fmt(n: number): string {
  return `${n.toFixed(0)} ms`;
}

function run(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }

  const config = new Configuration(new DesktopSettingsReader());
  const db = new IndexDb(dbPath);

  console.log(`corpus: ${config.getClaudeProjectsPathOverride() ?? '~/.claude/projects'}`);
  console.log(`index:  ${dbPath}\n`);

  // --- cold index -----------------------------------------------------------
  let discoveredAt = 0;
  let firstRowsAt = 0;
  const coldStart = process.hrtime.bigint();
  const indexer = new ClaudeIndexer({
    db,
    config,
    onDiscovered: () => {
      discoveredAt = ms(coldStart);
    },
    onRows: () => {
      if (firstRowsAt === 0) {
        firstRowsAt = ms(coldStart);
      }
    },
  });
  const result = indexer.run();
  const coldTotal = ms(coldStart);

  console.log('COLD INDEX (no existing index)');
  console.log(`  discovery ............ ${fmt(discoveredAt)}  (${result.discovered} sessions found)`);
  console.log(`  first rows written ... ${fmt(firstRowsAt)}   <- list can paint here`);
  console.log(`  full hydration ....... ${fmt(coldTotal)}  (${result.hydrated} parsed)\n`);

  // --- warm queries ---------------------------------------------------------
  const queryStart = process.hrtime.bigint();
  const rows = db.listSessions({ limit: 300 });
  const queryMs = ms(queryStart);

  const groupStart = process.hrtime.bigint();
  const groups = db.listGroups();
  const groupMs = ms(groupStart);

  const searchStart = process.hrtime.bigint();
  const found = db.listSessions({ query: 'fix', limit: 300 });
  const searchMs = ms(searchStart);

  console.log('WARM QUERIES (what every app launch after the first pays)');
  console.log(`  list 300 rows ........ ${queryMs.toFixed(1)} ms  (${rows.length} returned)`);
  console.log(`  group headers ........ ${groupMs.toFixed(1)} ms  (${groups.length} groups)`);
  console.log(`  search "fix" ......... ${searchMs.toFixed(1)} ms  (${found.length} matched)\n`);

  // --- no-op re-index -------------------------------------------------------
  const reStart = process.hrtime.bigint();
  const second = new ClaudeIndexer({ db, config }).run();
  const reMs = ms(reStart);
  console.log('RE-INDEX (nothing changed on disk)');
  console.log(`  full pass ............ ${fmt(reMs)}  (${second.hydrated} re-parsed)\n`);

  const counts = db.counts();
  console.log(`indexed ${counts.indexed} of ${counts.total} sessions`);
  const size = fs.statSync(dbPath).size;
  console.log(`index size: ${(size / 1024 / 1024).toFixed(1)} MB`);

  db.close();
  if (!keep) {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(dbPath + suffix, { force: true });
    }
  }
}

run();
