import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Configuration } from '@agent-observability/core/src/config/configuration';
import { DesktopSettingsReader } from './drivers/desktopConfig';
import { AiBackendHolder, DESKTOP_CLI_HINTS } from './aiBackends';

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ao-aibackends-'));
  file = path.join(dir, 'config.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function holder(): AiBackendHolder {
  return new AiBackendHolder(new Configuration(new DesktopSettingsReader(file)));
}

describe('AiBackendHolder', () => {
  it("serves the Claude backend even though core's default backend is 'copilot'", () => {
    // The desktop cannot run the vscode.lm-based Copilot backend; without the
    // first-registered fallback the AI Helper would be dead on a default config.
    expect(holder().active().id).toBe('claude-code');
  });

  it('reload() swaps in a fresh backend, dropping the cached CLI probe', () => {
    const h = holder();
    const before = h.active();
    h.reload();
    expect(h.active()).not.toBe(before);
    expect(h.active().id).toBe('claude-code');
  });
});

describe('DESKTOP_CLI_HINTS', () => {
  it('points at the desktop Settings view, never a VS Code setting id', () => {
    expect(DESKTOP_CLI_HINTS.cliPathHint).toContain('Settings');
    expect(DESKTOP_CLI_HINTS.cliPathHint).not.toContain('agentObservability.');
  });
});
