/**
 * Head-to-head: time to a painted session list, extension approach vs. indexed
 * approach, over the same corpus on this machine.
 *
 * The extension builds its list by parsing transcripts on demand, so the number
 * that matters there is how long `listSessions()` takes on a cold cache — that
 * is time the user spends looking at an empty tree.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { ClaudeIndexer } from '../src/datahost/indexer/claudeIndexer';
import { IndexDb } from '../src/datahost/indexer/indexDb';

const dbPath = path.join(os.tmpdir(), `ao-compare-${process.pid}.db`);

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}

function main(): void {
  cleanup();
  const config = new Configuration(new DesktopSettingsReader());

  // --- extension path -------------------------------------------------------
  const extStart = process.hrtime.bigint();
  const service = new ClaudeCodeService(config);
  const listed = service.listSessions();
  const extMs = ms(extStart);
  const count = listed.ok ? listed.value.length : 0;

  // --- desktop path ---------------------------------------------------------
  const db = new IndexDb(dbPath);
  // Cold: build the index once, as the app does on first launch.
  let paintMs = 0;
  const coldStart = process.hrtime.bigint();
  const indexer = new ClaudeIndexer({
    db,
    config,
    onRows: () => {
      if (paintMs === 0) {
        paintMs = ms(coldStart);
      }
    },
  });
  indexer.run();
  const coldMs = ms(coldStart);

  // Warm: every launch after the first.
  const warmStart = process.hrtime.bigint();
  const rows = db.listSessions({ limit: 300 });
  const warmMs = ms(warmStart);

  console.log('\nTIME TO A USABLE SESSION LIST\n');
  console.log(`  extension (parse on demand) .... ${extMs.toFixed(0)} ms   ${count} sessions`);
  console.log(`  desktop, first launch .......... ${paintMs.toFixed(0)} ms   list paints, hydrates over ${(coldMs / 1000).toFixed(1)}s behind it`);
  console.log(`  desktop, every launch after .... ${warmMs.toFixed(1)} ms   ${rows.length} sessions\n`);
  console.log(`  cold speedup ${(extMs / Math.max(paintMs, 0.1)).toFixed(0)}x, warm speedup ${(extMs / Math.max(warmMs, 0.1)).toFixed(0)}x\n`);

  db.close();
  cleanup();
}

main();
