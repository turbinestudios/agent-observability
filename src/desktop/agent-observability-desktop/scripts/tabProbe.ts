/**
 * Why doesn't the Context Analysis tab respond to a click?
 *
 * The controller wires every interaction from one inline script. If that script
 * fails to parse, nothing gets a listener and the whole document goes inert —
 * which looks exactly like "the tab does nothing". So: pull the script out of a
 * real rendered document, check it parses, and confirm the markup it expects is
 * actually there.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { ClaudeCodeService } from '@agent-observability/core/src/claude/claudeCodeService';
import { SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import { DesktopSettingsReader } from '../src/datahost/drivers/desktopConfig';
import { DetailRenderer } from '../src/datahost/detail/detailRenderer';
import { IndexDb } from '../src/datahost/indexer/indexDb';

function check(label: string, ok: boolean, extra = ''): void {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${extra === '' ? '' : ` — ${extra}`}`);
}

function main(): void {
  const settings = new DesktopSettingsReader();
  const config = new Configuration(settings);
  const db = new IndexDb();
  const sources = new SourceRegistry([new ClaudeCodeService(config)]);
  const renderer = new DetailRenderer(sources);

  const row = db
    .listSessions({ source: 'claude', limit: 200 })
    .filter((r) => r.interactionCount > 0)
    .sort((a, b) => a.interactionCount - b.interactionCount)[0];
  if (row === undefined) {
    console.log('no claude session to render');
    return;
  }

  const html = renderer.renderDocument('claude', row.sessionId, 'dark', row.indexedAtMs, {
    acceptedMissing: { files: [], sources: [] },
  });

  console.log(`session: ${row.title ?? row.sessionId}\n`);

  console.log('markup:');
  check('tab bar present', html.includes('class="tab-bar"'));
  check('context tab button', html.includes('data-tab="tab-context"'));
  check('context panel', html.includes('id="tab-context"'));
  check('nav closes properly', html.includes('</nav>'));
  check('live-root present', html.includes('id="live-root"'));

  // Every inline <script> in the document must parse, or the document is inert.
  console.log('\ninline scripts:');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  console.log(`  found ${scripts.length}`);
  scripts.forEach((body, index) => {
    try {
      // eslint-disable-next-line no-new-func
      new Function(body);
      check(`script ${index + 1} parses (${body.length} chars)`, true);
    } catch (err) {
      check(
        `script ${index + 1} parses (${body.length} chars)`,
        false,
        err instanceof Error ? err.message : String(err),
      );
      const line = /(\d+)/.exec(String(err))?.[1];
      console.log(`       near: ${body.slice(0, 200).replace(/\n/g, ' ')}`);
      if (line !== undefined) {
        console.log(`       (reported position ${line})`);
      }
    }
  });

  const out = path.join(os.tmpdir(), 'ao-tab-probe.html');
  fs.writeFileSync(out, html);
  console.log(`\nwrote ${out}`);

  db.close();
}

main();
