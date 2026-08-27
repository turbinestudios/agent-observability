/**
 * Exercises the new data-host features against this machine's real index:
 * the overview aggregation, and whether the Context Analysis tab actually
 * appears for a real session of each source.
 */
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { TelemetryService } from '@agent-observability/core/src/telemetry/telemetryService';
import { CopilotSource, SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { DetailRenderer } from '../src/datahost/detail/detailRenderer';
import { IndexDb } from '../src/datahost/indexer/indexDb';

function ms(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function main(): void {
  const settings = new DesktopSettingsReader();
  const config = new Configuration(settings);
  const db = new IndexDb();

  const telemetry = new TelemetryService(config);
  telemetry.setArchiveDbPath(resolveArchiveDbPath(config));
  const sources = new SourceRegistry([new ClaudeCodeService(config), new CopilotSource(telemetry, config)]);
  const renderer = new DetailRenderer(sources);

  // --- overview -------------------------------------------------------------
  const started = process.hrtime.bigint();
  const overview = db.overview(30);
  const overviewMs = ms(started);

  console.log(`OVERVIEW  (${overviewMs.toFixed(1)} ms)`);
  const t = overview.totals;
  console.log(`  ${t.sessions} sessions · ${t.steps.toLocaleString()} steps · ${t.repositories} repos · ${t.models} models`);
  console.log(`  tokens in ${t.inputTokens.toLocaleString()} / out ${t.outputTokens.toLocaleString()} / cached ${t.cachedTokens.toLocaleString()}`);
  console.log(`  avg session ${(t.avgSessionMs / 1000 / 60).toFixed(1)} min`);
  console.log(`  by source: ${overview.bySource.map((s) => `${s.source}=${s.sessions}`).join(', ')}`);
  const activeDays = new Set(overview.daily.map((d) => d.day)).size;
  console.log(`  daily points: ${overview.daily.length} rows across ${activeDays} active day(s) in ${overview.windowDays}d`);
  console.log(`  top repos: ${overview.topRepositories.map((r) => `${r.repository.split('/').slice(-1)[0]}(${r.sessions})`).join(', ')}\n`);

  // --- context analysis tab -------------------------------------------------
  const acceptedMissing = {
    files: settings.get<string[]>('context.acceptedMissingFiles', []),
    sources: settings.get<string[]>('context.acceptedMissingSources', []),
  };

  for (const source of ['claude', 'copilot']) {
    // Pick a session that actually resolved a repository, and a small one —
    // the header rows are what is under test here, not parse throughput.
    const candidates = db.listSessions({ source, limit: 400 });
    const row = candidates
      .filter((r) => r.repository !== 'unknown' && r.interactionCount > 0)
      .sort((a, b) => a.interactionCount - b.interactionCount)[0];
    if (row === undefined) {
      console.log(`${source}: no session with a resolved repository\n`);
      continue;
    }
    const begin = process.hrtime.bigint();
    let html: string;
    try {
      html = renderer.renderDocument(source, row.sessionId, 'dark', row.indexedAtMs, {
        acceptedMissing,
      });
    } catch (err) {
      console.log(`${source}: render failed — ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
    const first = ms(begin);
    const cachedStart = process.hrtime.bigint();
    renderer.renderDocument(source, row.sessionId, 'dark', row.indexedAtMs, { acceptedMissing });
    const cached = ms(cachedStart);

    console.log(`${source.toUpperCase()}  "${(row.title ?? row.sessionId).slice(0, 40)}"`);
    console.log(`  render ${first.toFixed(0)} ms, cached ${cached.toFixed(0)} ms`);
    console.log(`  ${check('Context Analysis tab', html.includes('data-tab="tab-context"'))}`);
    console.log(`  ${check('context panel', html.includes('id="tab-context"'))}`);
    console.log(`  ${check('repository row', html.includes('<dt>Repository</dt>'))}`);
    console.log(`  ${check('repository is a link', html.includes('class="repo-link"'))}`);
    console.log(`  ${check('external-link handler', html.includes("'open-external-url'"))}`);

    // Renaming must reach the rendered header, not just the list row.
    const renamed = renderer.renderDocument(source, row.sessionId, 'dark', row.indexedAtMs, {
      acceptedMissing,
      renamedTitle: 'Renamed for the probe',
    });
    console.log(`  ${check('rename reaches the header', renamed.includes('Renamed for the probe'))}\n`);
  }

  db.close();
}

function check(label: string, ok: boolean): string {
  return `${ok ? 'ok  ' : 'FAIL'} ${label}`;
}

main();
