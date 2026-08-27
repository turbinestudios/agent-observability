/**
 * Where the time goes when opening a Copilot session detail, and whether the
 * cost is paid once per app run or on every session.
 */
import * as fs from 'node:fs';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import { CopilotSource } from '@agent-observability/core/src/sources/sessionSource';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { IndexDb } from '../src/datahost/indexer/indexDb';

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function main(): void {
  const settings = new DesktopSettingsReader();
  const config = new Configuration(settings);
  const db = new IndexDb();

  const archive = resolveArchiveDbPath(config);
  const size = archive !== undefined && fs.existsSync(archive) ? fs.statSync(archive).size : 0;
  console.log(`archive: ${(size / 1024 / 1024).toFixed(0)} MB\n`);

  const telemetry = new TelemetryService(config);
  telemetry.setArchiveDbPath(archive);
  const source = new CopilotSource(telemetry, config);

  const rows = db.listSessions({ source: 'copilot', limit: 3 });
  const accepted = { files: [] as string[], sources: [] as string[] };

  rows.forEach((row, index) => {
    const label = `#${index + 1} ${(row.title ?? row.sessionId).slice(0, 32)}`;

    const d0 = process.hrtime.bigint();
    const detail = source.getSessionDetail(row.sessionId);
    const detailMs = ms(d0);

    const c0 = process.hrtime.bigint();
    source.getContextAnalysis?.(row.sessionId, accepted);
    const contextMs = ms(c0);

    console.log(`${label}`);
    console.log(`  getSessionDetail    ${detailMs.toFixed(0).padStart(7)} ms  ${detail.ok ? 'ok' : detail.message}`);
    console.log(`  getContextAnalysis  ${contextMs.toFixed(0).padStart(7)} ms`);
    if (index === 0) {
      console.log('  (the first call also pays the one-time snapshot copy)');
    }
    console.log();
  });

  db.close();
}

main();
