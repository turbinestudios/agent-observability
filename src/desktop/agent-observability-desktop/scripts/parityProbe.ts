/**
 * Compares what the extension's Copilot source lists against what the desktop
 * indexer produces from the same data, so a difference is a finding rather than
 * a guess. Parity is the requirement; speed is only worth anything if the rows
 * match.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import { CopilotSource } from '@agent-observability/core/src/sources/sessionSource';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { CopilotIndexer } from '../src/datahost/indexer/copilotIndexer';
import { IndexDb } from '../src/datahost/indexer/indexDb';

const dbPath = path.join(os.tmpdir(), `ao-parity-${process.pid}.db`);

function cleanup(): void {
  for (const suffix of ['', '-wal', '-shm']) {
    fs.rmSync(dbPath + suffix, { force: true });
  }
}

function pct(part: number, whole: number): string {
  return whole === 0 ? '0%' : `${Math.round((part / whole) * 100)}%`;
}

function main(): void {
  cleanup();
  const config = new Configuration(new DesktopSettingsReader());

  // --- extension path -------------------------------------------------------
  // Point it at the durable archive exactly as extension.ts does at startup;
  // without this the comparison is against a rolling window, not what a user
  // actually sees.
  const telemetry = new TelemetryService(config);
  telemetry.setArchiveDbPath(resolveArchiveDbPath(config));

  const extStart = process.hrtime.bigint();
  const source = new CopilotSource(telemetry, config);
  const listed = source.listSessions();
  const extMs = Number(process.hrtime.bigint() - extStart) / 1e6;

  if (!listed.ok) {
    console.log(`extension source failed: ${listed.message}`);
    return;
  }
  const extension = listed.value;
  const extTitles = extension.filter((s) => s.title !== undefined).length;
  const extRepos = extension.filter((s) => s.repository !== 'unknown').length;

  console.log('EXTENSION (CopilotSource.listSessions)');
  console.log(`  ${extension.length} sessions in ${extMs.toFixed(0)} ms`);
  console.log(`  titles ${extTitles} (${pct(extTitles, extension.length)}) · repos ${extRepos} (${pct(extRepos, extension.length)})\n`);

  // --- desktop path ---------------------------------------------------------
  const db = new IndexDb(dbPath);
  const deskStart = process.hrtime.bigint();
  new CopilotIndexer({ db, config }).run();
  const deskMs = Number(process.hrtime.bigint() - deskStart) / 1e6;
  const desktop = db.listSessions({ source: 'copilot', limit: 2000 });
  const deskTitles = desktop.filter((s) => s.title !== undefined).length;
  const deskRepos = desktop.filter((s) => s.repository !== 'unknown').length;

  console.log('DESKTOP (indexer)');
  console.log(`  ${desktop.length} sessions in ${deskMs.toFixed(0)} ms`);
  console.log(`  titles ${deskTitles} (${pct(deskTitles, desktop.length)}) · repos ${deskRepos} (${pct(deskRepos, desktop.length)})\n`);

  // --- differences ----------------------------------------------------------
  const extById = new Map(extension.map((s) => [s.sessionId, s]));
  const deskById = new Map(desktop.map((s) => [s.sessionId, s]));
  const onlyExt = [...extById.keys()].filter((id) => !deskById.has(id));
  const onlyDesk = [...deskById.keys()].filter((id) => !extById.has(id));

  console.log('DIFFERENCES');
  console.log(`  only in extension: ${onlyExt.length}`);
  console.log(`  only in desktop:   ${onlyDesk.length}`);

  let countMismatch = 0;
  for (const [id, ext] of extById) {
    const desk = deskById.get(id);
    if (desk !== undefined && desk.interactionCount !== ext.interactionCount) {
      countMismatch += 1;
    }
  }
  console.log(`  step counts differing on shared sessions: ${countMismatch}`);

  if (onlyExt.length > 0) {
    console.log('\n  sample only-in-extension:');
    for (const id of onlyExt.slice(0, 3)) {
      const s = extById.get(id);
      console.log(`    ${id.slice(0, 40)} — ${s?.interactionCount} steps, repo ${s?.repository}`);
    }
  }
  if (onlyDesk.length > 0) {
    console.log('\n  sample only-in-desktop:');
    for (const id of onlyDesk.slice(0, 3)) {
      const s = deskById.get(id);
      console.log(`    ${id.slice(0, 40)} — ${s?.interactionCount} steps, repo ${s?.repository}`);
    }
  }

  db.close();
  cleanup();
}

main();
