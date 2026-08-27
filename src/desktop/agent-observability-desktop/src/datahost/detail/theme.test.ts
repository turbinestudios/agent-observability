import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { detailHeadHtml } from './theme';

/**
 * The shared renderer styles itself with VS Code theme variables that only
 * exist inside the extension host. This app supplies them instead of forking
 * the renderer — which works only as long as the supplied set stays complete.
 *
 * A variable added to the renderer and missed here does not throw: the element
 * silently renders with no color, which is easy to ship without noticing. So
 * the test reads the renderer's own source and requires full coverage.
 */

const RENDERER = path.resolve(
  __dirname,
  '../../../../../core/agent-observability-core/src/views/sessionDetailHtml.ts',
);

function variablesUsedByRenderer(): string[] {
  const source = fs.readFileSync(RENDERER, 'utf8');
  return [...new Set([...source.matchAll(/var\((--vscode-[A-Za-z0-9-]+)/g)].map((m) => m[1]))].sort();
}

function variablesDefined(css: string): Set<string> {
  return new Set([...css.matchAll(/(--vscode-[A-Za-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

describe('detail theme', () => {
  it('finds the renderer it is themeing', () => {
    expect(fs.existsSync(RENDERER)).toBe(true);
    expect(variablesUsedByRenderer().length).toBeGreaterThan(20);
  });

  it.each(['light', 'dark'] as const)('defines every variable the renderer uses (%s)', (theme) => {
    const defined = variablesDefined(detailHeadHtml('abc123', theme));
    const missing = variablesUsedByRenderer().filter((name) => !defined.has(name));
    expect(missing).toEqual([]);
  });

  it('gives light and dark the same variables, so neither theme has gaps', () => {
    expect([...variablesDefined(detailHeadHtml('n', 'dark'))].sort()).toEqual(
      [...variablesDefined(detailHeadHtml('n', 'light'))].sort(),
    );
  });

  it('actually differs between themes', () => {
    expect(detailHeadHtml('n', 'dark')).not.toBe(detailHeadHtml('n', 'light'));
  });

  it('tags its style and script with the supplied nonce', () => {
    // The document's CSP admits styles and scripts by nonce only; without a
    // match the theme and the shim are both silently dropped.
    const html = detailHeadHtml('nonce-xyz', 'dark');
    expect(html).toContain('<style nonce="nonce-xyz">');
    expect(html).toContain('<script nonce="nonce-xyz">');
  });

  it('shims acquireVsCodeApi, which the renderer calls unconditionally', () => {
    const html = detailHeadHtml('n', 'light');
    expect(html).toContain('window.acquireVsCodeApi');
    // Messages must reach the app shell, which forwards them to the data host.
    expect(html).toContain('parent.postMessage');
    expect(html).toContain('__aoDetail');
  });

  it('exposes getState and setState, which webview scripts expect to exist', () => {
    const html = detailHeadHtml('n', 'light');
    expect(html).toContain('getState');
    expect(html).toContain('setState');
  });
});
