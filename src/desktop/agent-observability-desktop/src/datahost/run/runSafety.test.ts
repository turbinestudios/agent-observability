import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Guards for two promises Run makes, checked against the source and the
 * packaging config so neither can be broken by accident:
 *
 * 1. The app never answers a permission request on the user's behalf and
 *    never persists an approval. The SDK offers helpers and result kinds that
 *    would do exactly that; none of them may appear under `datahost/run`.
 * 2. The app ships no Copilot runtime. It depends on the SDK, excludes the
 *    SDK's bundled per-platform runtime packages from the installer, and
 *    excludes the native module the SDK only needs for a connection mode the
 *    app does not use.
 */

const RUN_DIR = __dirname;
const PACKAGE_DIR = path.resolve(__dirname, '../../..');

// Assembled from pieces so this file does not contain what it forbids.
const FORBIDDEN = [
  ['approve', 'All'].join(''),
  ['allow', 'all'].join('-'),
  ['approve', 'permanently'].join('-'),
  ['approve', 'for', 'location'].join('-'),
  ['--', 'yolo'].join(''),
];

describe('run host safety', () => {
  it('contains no way to approve everything or to persist an approval', () => {
    const sources = fs
      .readdirSync(RUN_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => ({ name, text: fs.readFileSync(path.join(RUN_DIR, name), 'utf8') }));
    expect(sources.length).toBeGreaterThan(3);
    for (const source of sources) {
      for (const word of FORBIDDEN) {
        expect(source.text.toLowerCase().includes(word.toLowerCase()), `${source.name} contains "${word}"`).toBe(false);
      }
    }
  });

  it('keeps the SDK import in one file', () => {
    const importers = fs
      .readdirSync(RUN_DIR)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .filter((name) => /require\('@github\/copilot-sdk'\)|from '@github\/copilot-sdk'/.test(fs.readFileSync(path.join(RUN_DIR, name), 'utf8')));
    expect(importers).toEqual(['sdkDriver.ts']);
  });
});

describe('run packaging', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(PACKAGE_DIR, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const builder = fs.readFileSync(path.join(PACKAGE_DIR, 'electron-builder.yml'), 'utf8');

  it('declares the SDK as a runtime dependency so it is externalized, not bundled', () => {
    expect(Object.keys(manifest.dependencies ?? {})).toContain('@github/copilot-sdk');
  });

  it('ships no bundled Copilot runtime and not the unused native module', () => {
    expect(builder).toContain('"!node_modules/@github/copilot-sdk-*/**"');
    expect(builder).toContain('"!node_modules/koffi/**"');
    expect(Object.keys(manifest.dependencies ?? {}).some((name) => name.startsWith('@github/copilot-sdk-'))).toBe(false);
  });

  it('can load the SDK without the native module it only needs for the in-process connection', () => {
    // If a future SDK version starts loading koffi eagerly, excluding it from
    // the installer would break Run at first use: this is the early warning.
    const require = createRequire(__filename);
    const sdk = require('@github/copilot-sdk') as Record<string, unknown>;
    expect(typeof sdk.CopilotClient).toBe('function');
    expect(typeof (sdk.RuntimeConnection as { forStdio?: unknown }).forStdio).toBe('function');
    expect(Object.keys(require.cache).some((key) => /[\\/]node_modules[\\/]koffi[\\/]/.test(key))).toBe(false);
  });
});
