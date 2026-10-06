import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Guards for two promises Run makes, checked against the source and the
 * packaging config so neither can be broken by accident:
 *
 * 1. Approvals never outlive the session, and allow-all has exactly one door.
 *    The SDK has result kinds that persist an approval into the user's Copilot
 *    configuration; none may appear under `datahost/run`. The runtime's own
 *    allow-all mode (what `copilot --allow-all` turns on) is reachable only
 *    through `SdkRunDriver.setAllowAll`, per session, and that method is
 *    called only from the controller, on the user's choice for that session.
 *    The SDK's approve-everything permission handler, the process-wide
 *    command-line flags and the environment variable are not used at all:
 *    each would apply without the session's mode saying so.
 * 2. The app ships no Copilot runtime. It depends on the SDK, excludes the
 *    SDK's bundled per-platform runtime packages from the installer, and
 *    excludes the native module the SDK only needs for a connection mode the
 *    app does not use.
 */

const RUN_DIR = __dirname;
const PACKAGE_DIR = path.resolve(__dirname, '../../..');

// Assembled from pieces so this file does not contain what it forbids.
const FORBIDDEN = [
  // The SDK's handler that approves every request without the host seeing it.
  ['onPermissionRequest:', ['approve', 'All'].join('')].join(' '),
  ['import {', ['approve', 'All'].join('')].join(' '),
  // The process-wide environment switch.
  ['COPILOT', 'ALLOW', 'ALL'].join('_'),
  // Approvals that persist beyond the session.
  ['approve', 'permanently'].join('-'),
  ['approve', 'for', 'location'].join('-'),
];

function sources(): { name: string; text: string }[] {
  return fs
    .readdirSync(RUN_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .map((name) => ({ name, text: fs.readFileSync(path.join(RUN_DIR, name), 'utf8') }));
}

/**
 * A process-wide command-line switch passed as an argument: the flag as a
 * whole string literal. (The words may appear in a message shown to the
 * user, which names the flag the mode corresponds to.)
 */
const FLAG_ARGUMENT = new RegExp(`['"\`]--(${['allow', 'all'].join('-')}[a-z-]*|${'yo' + 'lo'})['"\`]`, 'i');

/** Source with comments removed, so prose about a rule is not mistaken for code breaking it. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('run host safety', () => {
  it('never uses a process-wide allow-all, the approve-everything handler, or an approval that persists', () => {
    const all = sources();
    expect(all.length).toBeGreaterThan(3);
    for (const source of all) {
      for (const word of FORBIDDEN) {
        expect(code(source.text).toLowerCase().includes(word.toLowerCase()), `${source.name} contains "${word}"`).toBe(false);
      }
      expect(FLAG_ARGUMENT.test(code(source.text)), `${source.name} passes a process-wide flag`).toBe(false);
    }
  });

  it("reaches the runtime's allow-all mode through one driver method, called from one place", () => {
    const all = sources().map((source) => ({ name: source.name, text: code(source.text) }));
    // The mode is set on the runtime only inside the SDK driver...
    expect(all.filter((source) => /\.setMode\(/.test(source.text)).map((source) => source.name)).toEqual(['sdkDriver.ts']);
    const driver = all.find((source) => source.name === 'sdkDriver.ts')?.text ?? '';
    expect(driver.match(/\.setMode\(/g)).toHaveLength(1);
    // ...and that door is opened only by the controller's mode switch.
    expect(all.filter((source) => /\.setAllowAll\(/.test(source.text)).map((source) => source.name)).toEqual(['runController.ts']);
    const controller = all.find((source) => source.name === 'runController.ts')?.text ?? '';
    expect(controller.match(/\.setAllowAll\(/g)).toHaveLength(1);
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
