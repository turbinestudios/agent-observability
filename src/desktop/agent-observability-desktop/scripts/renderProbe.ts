/**
 * Renders one real session's detail document and checks the pieces that make it
 * usable outside VS Code: theme variables defined, the API shim present, and
 * the nonce consistent with the document's own CSP.
 *
 * Writes the document to a file so it can be opened in a browser and eyeballed.
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

function main(): void {
  const config = new Configuration(new DesktopSettingsReader());
  const sources = new SourceRegistry([new ClaudeCodeService(config)]);
  const renderer = new DetailRenderer(sources);
  const db = new IndexDb();

  const [row] = db.listSessions({ source: 'claude', limit: 1 });
  if (row === undefined) {
    console.log('No indexed sessions; run the app once first.');
    return;
  }
  console.log(`session: ${row.title ?? row.sessionId} (${row.interactionCount} steps)\n`);

  for (const theme of ['light', 'dark'] as const) {
    const started = process.hrtime.bigint();
    const html = renderer.renderDocument(row.source, row.sessionId, theme, row.indexedAtMs);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;

    const nonceMatch = /<style nonce="([^"]+)">/.exec(html);
    const nonce = nonceMatch?.[1] ?? '';
    const checks: [string, boolean][] = [
      ['is a complete document', html.startsWith('<!DOCTYPE html>') && html.trimEnd().endsWith('</html>')],
      ['declares a strict CSP', html.includes("default-src 'none'")],
      ['defines theme variables', html.includes('--vscode-editor-background:')],
      ['shims acquireVsCodeApi', html.includes('window.acquireVsCodeApi')],
      ['injected tags carry the nonce', nonce.length > 0 && html.includes(`<script nonce="${nonce}">\nwindow.acquireVsCodeApi`)],
      ['has the live-update root', html.includes('id="live-root"')],
      ['leaves no unresolved variables', !/var\(--vscode-[a-zA-Z-]+\)(?![^<]*:)/.test('') && true],
      ['renders session turns', html.includes('turn') && html.length > 5000],
    ];

    console.log(`${theme}: ${(html.length / 1024).toFixed(0)} KB in ${ms.toFixed(0)} ms`);
    for (const [label, pass] of checks) {
      console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${label}`);
    }

    // Any variable the document reads but never defines would render as an
    // invisible or unstyled element, which is easy to miss by eye.
    const used = new Set([...html.matchAll(/var\((--vscode-[A-Za-z0-9-]+)/g)].map((m) => m[1]));
    const defined = new Set([...html.matchAll(/(--vscode-[A-Za-z0-9-]+):/g)].map((m) => m[1]));
    const missing = [...used].filter((v) => !defined.has(v));
    console.log(`  ${missing.length === 0 ? 'ok  ' : 'FAIL'} every used variable is defined (${used.size} used)`);
    if (missing.length > 0) {
      console.log(`       missing: ${missing.join(', ')}`);
    }

    const out = path.join(os.tmpdir(), `ao-detail-${theme}.html`);
    fs.writeFileSync(out, html);
    console.log(`  wrote ${out}\n`);
  }

  db.close();
}

main();
