/**
 * Dumps the context entries a real session produces, to see exactly what the
 * "Loaded context files" list is being given: the names it shows, the paths it
 * puts in the tooltip, and which entries are flagged oversized.
 */
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import { CopilotSource } from '@agent-observability/core/src/sources/sessionSource';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { OVERSIZED_THRESHOLD_TOKENS } from '@agent-observability/core/src/context/sizeEstimator';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { IndexDb } from '../src/datahost/indexer/indexDb';

/** Shows backslashes literally, so a doubled separator is visible as data. */
function raw(value: string | undefined): string {
  if (value === undefined) {
    return '(none)';
  }
  const doubled = value.includes('\\\\') ? '   <-- CONTAINS A DOUBLED SEPARATOR' : '';
  return `${value}${doubled}`;
}

function main(): void {
  const config = new Configuration(new DesktopSettingsReader());
  const db = new IndexDb();
  const claude = new ClaudeCodeService(config);

  // Copilot builds its context list from discovery events rather than the
  // transcript, so its file names can differ from Claude's.
  const telemetry = new TelemetryService(config);
  telemetry.setArchiveDbPath(resolveArchiveDbPath(config));
  const copilot = new CopilotSource(telemetry, config);
  const [copilotRow] = db.listSessions({ source: 'copilot', limit: 1 });
  if (copilotRow !== undefined) {
    const analysis = copilot.getContextAnalysis?.(copilotRow.sessionId, { files: [], sources: [] });
    console.log(`=== COPILOT: ${(copilotRow.title ?? copilotRow.sessionId).slice(0, 40)} ===`);
    for (const f of (analysis?.total.loadedFiles ?? []).slice(0, 12)) {
      console.log(`  name=${f.name}`);
      console.log(`      path=${raw(f.filePath)}`);
      console.log(`      category=${f.category} tokens=${f.estimatedTokens ?? '-'}`);
    }
    console.log();
  }

  console.log(`oversized threshold: ${OVERSIZED_THRESHOLD_TOKENS} estimated tokens\n`);

  const rows = db.listSessions({ source: 'claude', limit: 60 });
  let shown = 0;

  for (const row of rows) {
    const analysis = claude.getContextAnalysis?.(row.sessionId, { files: [], sources: [] });
    if (analysis === undefined) {
      continue;
    }
    const files = analysis.total.loadedFiles;
    const skills = files.filter((f) => /skill\.md$/i.test(f.name) || /skill\.md$/i.test(f.filePath ?? ''));
    if (skills.length === 0 && analysis.total.oversizedFiles.length === 0) {
      continue;
    }

    console.log(`=== ${(row.title ?? row.sessionId).slice(0, 46)} ===`);
    console.log(`loaded files: ${files.length}, oversized: ${analysis.total.oversizedFiles.length}`);

    for (const f of files.slice(0, 14)) {
      console.log(`  name=${f.name}`);
      console.log(`      path=${raw(f.filePath)}`);
      console.log(`      category=${f.category} status=${f.status} tokens=${f.estimatedTokens ?? '-'}`);
    }
    for (const f of analysis.total.oversizedFiles) {
      const over = (f.estimatedTokens ?? 0) / OVERSIZED_THRESHOLD_TOKENS;
      console.log(`  OVERSIZED ${f.name} ~${f.estimatedTokens} tokens (${over.toFixed(1)}x threshold)`);
    }
    console.log();

    shown += 1;
    if (shown >= 3) {
      break;
    }
  }
  if (shown === 0) {
    console.log('no session surfaced skills or oversized files');
  }

  db.close();
}

main();
