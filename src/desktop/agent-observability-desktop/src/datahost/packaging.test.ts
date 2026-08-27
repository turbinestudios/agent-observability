import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Guards the packaging assumptions that, when broken, make the app start
 * normally and then do nothing — the worst kind of failure to diagnose.
 *
 * `node-sqlite3-wasm` locates its `.wasm` sidecar relative to its own
 * `__dirname`. If it is not a declared dependency, electron-vite bundles its
 * JavaScript into the data-host output, the sidecar lookup resolves next to the
 * bundle where no such file exists, and the whole process dies at import. The
 * window still opens and the session list just stays empty forever.
 *
 * It reaches the bundle transitively — importing `SourceRegistry` pulls in the
 * Copilot source — so nothing in the app's own imports makes the need obvious.
 */

const PACKAGE_JSON = path.resolve(__dirname, '../../package.json');

function manifest(): { dependencies?: Record<string, string> } {
  return JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8'));
}

describe('runtime dependencies', () => {
  it.each(['node-sqlite3-wasm', 'better-sqlite3'])(
    'declares %s so it is externalized rather than bundled',
    (name) => {
      expect(Object.keys(manifest().dependencies ?? {})).toContain(name);
    },
  );

  it('keeps the shared core a devDependency so it IS bundled', () => {
    // Core is TypeScript source with no build step; externalizing it would
    // leave a require() for a package that is not shipped.
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.devDependencies ?? {})).toContain('@agent-observability/core');
    expect(Object.keys(pkg.dependencies ?? {})).not.toContain('@agent-observability/core');
  });

  it('pins electron exactly, which electron-builder requires', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON, 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    // A range cannot be resolved to the per-release binary it downloads.
    expect(pkg.devDependencies?.electron).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
