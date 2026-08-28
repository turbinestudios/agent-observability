/**
 * Throwaway: run the real analyzer over the real corpus and report what it
 * would flag. Read-only — it parses transcripts and writes nothing.
 */
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import { DesktopSettingsReader } from './src/datahost/drivers/desktopConfig';
import { analyzeSession } from './src/datahost/analysis/sessionAnalyzer';

const LIMIT = Number(process.env.PROBE_LIMIT ?? 80);

const settings = new DesktopSettingsReader();
const config = new Configuration(settings);
const claude = new ClaudeCodeService(config);
const detector = new LocalDeviationDetector(config);

const listed = claude.listSessions(undefined, LIMIT);
if (!listed.ok) {
  console.log('could not list sessions:', listed.message);
  process.exit(0);
}

console.log(`threshold: ${config.getMaxSessionMinutes()} min per turn`);
console.log(`analyzing ${listed.value.length} most recent Claude sessions...`);

let flagged = 0;
let read = 0;

for (const summary of listed.value) {
  let result;
  try {
    result = analyzeSession(claude, summary.sessionId, {
      detector,
      acceptedMissing: { files: [], sources: [] },
    });
  } catch (err) {
    console.log(`  (failed to read ${summary.sessionId}: ${String(err).slice(0, 80)})`);
    continue;
  }
  if (result === undefined) {
    continue;
  }
  read++;
  if (result.deviationCount > 0) {
    flagged++;
    const detail = claude.getSessionDetail(summary.sessionId);
    const title = detail.ok ? (detail.value.summary.title ?? summary.sessionId) : summary.sessionId;
    console.log(`FLAGGED ${String(result.deviationCount).padStart(2)}x  ${String(title).slice(0, 64)}`);
  }
}

console.log(`\nread ${read} sessions, ${flagged} flagged`);
