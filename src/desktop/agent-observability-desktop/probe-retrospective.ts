/**
 * Throwaway: run the retrospective engine over the real local corpus and report
 * what it would say, to calibrate thresholds before any UI trusts them.
 * Read-only — it parses transcripts and writes nothing.
 *
 * From this directory:
 *   npx vite-node probe-retrospective.ts
 * Env knobs:
 *   PROBE_LIMIT=120        how many most-recent sessions to judge (default 80)
 *   PROBE_SESSION=<id>     print one session's full retrospective instead
 *
 * Output discipline: session titles and the engine's generic finding sentences
 * only — never prompt or response bodies.
 */
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import type { SessionRetrospective, SessionVerdict } from '@agent-observability/core/src/analysis/retrospective';
import { DesktopSettingsReader } from './src/datahost/drivers/desktopConfig';

const LIMIT = Number(process.env.PROBE_LIMIT ?? 80);
const ONLY = process.env.PROBE_SESSION;

const settings = new DesktopSettingsReader();
const config = new Configuration(settings);
const claude = new ClaudeCodeService(config);

function trim(text: string | undefined, max: number): string {
  if (text === undefined) {
    return '(untitled)';
  }
  const flat = text.replace(/\s+/gu, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function printFull(retro: SessionRetrospective, title: string | undefined): void {
  console.log(`\n=== ${trim(title, 80)}`);
  console.log(`    session ${retro.sessionId}`);
  console.log(`    goal (${retro.goalSource}, ${retro.goalConfidence}): ${trim(retro.goal, 100)}`);
  console.log(`    verdict: ${retro.verdict}  (${retro.verdictReasons.join(', ') || 'no findings'})`);
  console.log(`    outcome: ${retro.outcome}`);
  if (retro.firstPrompt !== undefined) {
    console.log(
      `    first prompt: ${retro.firstPrompt.rating} (${retro.firstPrompt.chars} chars, markers: ${retro.firstPrompt.markers.join('/') || 'none'})`,
    );
  }
  for (const f of retro.findings) {
    const where = f.turnIndex !== undefined ? ` [turn ${f.turnIndex + 1}]` : '';
    console.log(`    - ${f.severity.padEnd(8)} ${f.id}${where}: ${f.description}`);
  }
  for (const tip of retro.tips) {
    console.log(`    tip(${tip.id}): ${tip.text}`);
  }
}

const sessions = claude.listSessions(undefined, LIMIT);
if (!sessions.ok) {
  console.error(`Cannot list Claude sessions: ${sessions.message}`);
  process.exit(1);
}

if (ONLY !== undefined) {
  const retro = claude.getSessionRetrospective(ONLY);
  if (!retro.ok) {
    console.error(retro.message);
    process.exit(1);
  }
  const title = sessions.value.find((s) => s.sessionId === ONLY)?.title;
  printFull(retro.value, title);
  process.exit(0);
}

const histogram: Record<SessionVerdict, number> = { smooth: 0, bumpy: 0, struggled: 0, abandoned: 0 };
const judged: { retro: SessionRetrospective; title: string | undefined }[] = [];
let failed = 0;

for (const summary of sessions.value) {
  const retro = claude.getSessionRetrospective(summary.sessionId);
  if (!retro.ok) {
    failed++;
    continue;
  }
  histogram[retro.value.verdict]++;
  judged.push({ retro: retro.value, title: summary.title });
}

console.log(`Judged ${judged.length} sessions (${failed} unreadable).`);
console.log(
  `Verdicts: smooth ${histogram.smooth} · bumpy ${histogram.bumpy} · struggled ${histogram.struggled} · abandoned ${histogram.abandoned}`,
);
const hot = histogram.struggled + histogram.abandoned;
if (judged.length > 0 && hot / judged.length > 0.3) {
  console.log(`>> ${Math.round((hot / judged.length) * 100)}% struggled/abandoned — thresholds look too hot.`);
}

console.log('\nNon-smooth sessions:');
for (const { retro, title } of judged) {
  if (retro.verdict === 'smooth') {
    continue;
  }
  const c = retro.counts;
  console.log(
    `${retro.verdict.toUpperCase().padEnd(9)} corr=${c.correctionTurns} rep=${c.repeatedPromptTurns} int=${c.interruptions} streak=${c.maxErrorStreak} churn=${c.churnRatioPct}% cmp=${c.compactions} tips=${c.tipCount}  ${trim(title, 64)}`,
  );
}

const interesting = [...judged].sort((a, b) => b.retro.findings.length - a.retro.findings.length).slice(0, 3);
console.log('\nMost eventful sessions in full:');
for (const { retro, title } of interesting) {
  printFull(retro, title);
}
