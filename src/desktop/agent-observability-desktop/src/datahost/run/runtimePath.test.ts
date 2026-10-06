import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { RUNTIME_NOT_FOUND, resolveRuntimeTarget } from './runtimePath';

/**
 * A fake filesystem keyed by normalized path, so the same cases run on every
 * platform: paths are built with `path.join`, never with a literal separator.
 */
function fakeFs(files: Record<string, string>) {
  const map = new Map(Object.entries(files).map(([file, content]) => [path.normalize(file), content]));
  return {
    isFile: (p: string) => map.has(path.normalize(p)),
    readText: (p: string) => map.get(path.normalize(p)),
  };
}

const BIN = path.join(path.sep, 'tools', 'npm');
const PACKAGE = path.join(BIN, 'node_modules', '@github', 'copilot');
const ENTRY = path.join(PACKAGE, 'npm-loader.js');
const MANIFEST = path.join(PACKAGE, 'package.json');

describe('resolveRuntimeTarget', () => {
  it('resolves an npm shim on Windows to the package JS entry, with Electron told to act as node', () => {
    const result = resolveRuntimeTarget('', {
      platform: 'win32',
      env: { PATH: BIN },
      electron: true,
      ...fakeFs({
        [path.join(BIN, 'copilot')]: '#!/bin/sh',
        [path.join(BIN, 'copilot.cmd')]: '@echo off',
        [MANIFEST]: JSON.stringify({ bin: { copilot: 'npm-loader.js' } }),
        [ENTRY]: '',
      }),
    });
    expect(result).toEqual({ target: { path: ENTRY, env: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'npm-entry' } });
  });

  it('adds no Electron flag when the host is plain node', () => {
    const result = resolveRuntimeTarget(path.join(BIN, 'copilot.cmd'), {
      platform: 'win32',
      env: {},
      electron: false,
      ...fakeFs({
        [path.join(BIN, 'copilot.cmd')]: '',
        [MANIFEST]: JSON.stringify({ bin: 'npm-loader.js' }),
        [ENTRY]: '',
      }),
    });
    expect(result).toEqual({ target: { path: ENTRY, env: {}, kind: 'npm-entry' } });
  });

  it('uses a native executable as it is', () => {
    const exe = path.join(path.sep, 'opt', 'copilot', 'copilot');
    const result = resolveRuntimeTarget(exe, { platform: 'linux', env: {}, electron: true, ...fakeFs({ [exe]: '' }) });
    expect(result).toEqual({ target: { path: exe, env: {}, kind: 'native' } });
  });

  it('prefers a native .exe over a shim of the same name on PATH', () => {
    const exe = path.join(BIN, 'copilot.exe');
    const result = resolveRuntimeTarget('', {
      platform: 'win32',
      env: { Path: BIN },
      electron: true,
      ...fakeFs({ [exe]: '', [path.join(BIN, 'copilot.cmd')]: '' }),
    });
    expect(result).toEqual({ target: { path: exe, env: {}, kind: 'native' } });
  });

  it('never returns a .cmd shim it cannot resolve to an entry, since that needs a shell', () => {
    const result = resolveRuntimeTarget('', {
      platform: 'win32',
      env: { PATH: BIN },
      electron: true,
      ...fakeFs({ [path.join(BIN, 'copilot.cmd')]: '' }),
    });
    expect(result).toEqual({ problem: RUNTIME_NOT_FOUND });
  });

  it('skips a wrapper script that shadows the real install on PATH, as in a VS Code terminal', () => {
    // The Copilot Chat extension prepends a directory holding `copilot` (a
    // shell script), `copilot.bat` and `copilot.ps1` to its terminals' PATH.
    const wrapper = path.join(path.sep, 'vscode', 'copilotCli');
    const files = {
      [path.join(wrapper, 'copilot')]: '#!/bin/sh',
      [path.join(wrapper, 'copilot.bat')]: '@echo off',
      [path.join(wrapper, 'copilot.ps1')]: '',
    };
    const result = resolveRuntimeTarget('', {
      platform: 'win32',
      env: { PATH: [wrapper, BIN].join(path.delimiter) },
      electron: true,
      ...fakeFs({
        ...files,
        [path.join(BIN, 'copilot')]: '#!/bin/sh',
        [path.join(BIN, 'copilot.cmd')]: '@echo off',
        [MANIFEST]: JSON.stringify({ bin: { copilot: 'npm-loader.js' } }),
        [ENTRY]: '',
      }),
    });
    expect(result).toEqual({ target: { path: ENTRY, env: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'npm-entry' } });

    // With nothing else installed the wrapper is still not launched.
    expect(
      resolveRuntimeTarget('', { platform: 'win32', env: { PATH: wrapper }, electron: true, ...fakeFs(files) }),
    ).toEqual({ problem: RUNTIME_NOT_FOUND });
    // Elsewhere a file with no extension is how an executable looks.
    expect(
      resolveRuntimeTarget('', { platform: 'linux', env: { PATH: wrapper }, electron: true, ...fakeFs(files) }),
    ).toEqual({ target: { path: path.join(wrapper, 'copilot'), env: {}, kind: 'native' } });
  });

  it('rejects a manifest whose entry points outside the package', () => {
    const result = resolveRuntimeTarget(path.join(BIN, 'copilot.cmd'), {
      platform: 'win32',
      env: {},
      electron: true,
      ...fakeFs({
        [path.join(BIN, 'copilot.cmd')]: '',
        [MANIFEST]: JSON.stringify({ bin: { copilot: path.join('..', '..', '..', 'evil.js') } }),
        [path.join(BIN, 'node_modules', 'evil.js')]: '',
      }),
    });
    expect(result).toEqual({ problem: RUNTIME_NOT_FOUND });
  });

  it('accepts a configured JS entry directly and says how to fix a missing CLI', () => {
    expect(
      resolveRuntimeTarget(ENTRY, { platform: 'darwin', env: {}, electron: true, ...fakeFs({ [ENTRY]: '' }) }),
    ).toEqual({ target: { path: ENTRY, env: { ELECTRON_RUN_AS_NODE: '1' }, kind: 'npm-entry' } });
    const missing = resolveRuntimeTarget('', { platform: 'linux', env: { PATH: BIN }, electron: true, ...fakeFs({}) });
    expect(missing).toEqual({ problem: RUNTIME_NOT_FOUND });
    expect(RUNTIME_NOT_FOUND).toContain('Settings');
  });
});
