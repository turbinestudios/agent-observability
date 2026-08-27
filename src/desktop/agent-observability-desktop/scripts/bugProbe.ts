/**
 * Reproduces the reported failures against the real index:
 *  1. opening a Copilot session detail the way the data host actually wires it
 *  4. which repositories the index holds, and how their sessions are spread
 */
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import { CopilotSource } from '@agent-observability/core/src/sources/sessionSource';
import { resolveDatabasePaths } from '@agent-observability/core/src/telemetry/paths';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { IndexDb } from '../src/datahost/indexer/indexDb';

function main(): void {
  const config = new Configuration(new DesktopSettingsReader());
  const db = new IndexDb();

  console.log('=== 1. COPILOT DETAIL ===\n');
  console.log(`archive path : ${resolveArchiveDbPath(config) ?? '(none)'}`);
  const resolved = resolveDatabasePaths(config);
  console.log(`native paths : ${resolved.databases.length} found`);
  for (const d of resolved.databases) {
    console.log(`   ${d.source}: ${d.path}`);
  }
  console.log(`primary      : ${JSON.stringify(resolved.primary)}\n`);

  const [row] = db.listSessions({ source: 'copilot', limit: 1 });
  if (row === undefined) {
    console.log('no copilot sessions indexed\n');
  } else {
    // Exactly how the data host builds it today — no archive path set.
    const asWired = new CopilotSource(new TelemetryService(config), config);
    const a = asWired.getSessionDetail(row.sessionId);
    console.log(`as the data host wires it : ${a.ok ? 'ok' : `${a.reason} — ${a.message}`}`);

    // With the archive, which is where the indexer read the session from.
    const telemetry = new TelemetryService(config);
    telemetry.setArchiveDbPath(resolveArchiveDbPath(config));
    const withArchive = new CopilotSource(telemetry, config);
    const b = withArchive.getSessionDetail(row.sessionId);
    console.log(`with the archive set      : ${b.ok ? 'ok' : `${b.reason} — ${b.message}`}\n`);
  }

  console.log('=== 4. REPOSITORIES IN THE INDEX ===\n');
  const repos = db.listSessions({ limit: 2000 }).reduce((acc, r) => {
    const key = r.repository;
    const entry = acc.get(key) ?? { total: 0, claude: 0, copilot: 0 };
    entry.total += 1;
    if (r.source === 'claude') entry.claude += 1;
    if (r.source === 'copilot') entry.copilot += 1;
    acc.set(key, entry);
    return acc;
  }, new Map<string, { total: number; claude: number; copilot: number }>());

  const sorted = [...repos.entries()].sort((a, b) => b[1].total - a[1].total);
  console.log(`${sorted.length} distinct repository values\n`);
  for (const [repo, counts] of sorted) {
    console.log(`  ${String(counts.total).padStart(4)}  (c=${counts.claude} p=${counts.copilot})  ${repo}`);
  }

  db.close();
}

main();
