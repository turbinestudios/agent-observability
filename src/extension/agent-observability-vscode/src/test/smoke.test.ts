import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Contract-stability smoke test (proves the vitest harness runs headless).
 *
 * Later phases depend on these exact ids/keys. Rather than importing the
 * `vscode`-coupled source modules (which cannot load outside the Extension
 * Host), we assert the manifest contract directly — package.json is the single
 * source of truth shared with the rest of the extension and the dashboard.
 *
 * package.json is read at runtime via fs (not imported) so it stays outside
 * the TypeScript `rootDir: src` compilation root.
 */

interface CommandContribution {
  command: string;
  category?: string;
}
interface ViewContribution {
  id: string;
}
interface ConfigProperty {
  default: unknown;
  minimum?: number;
}
interface Manifest {
  name: string;
  publisher: string;
  main: string;
  engines: { vscode: string };
  activationEvents: string[];
  contributes: {
    commands: CommandContribution[];
    viewsContainers: { activitybar: ViewContribution[] };
    views: Record<string, ViewContribution[]>;
    configuration: { properties: Record<string, ConfigProperty> };
  };
}

const manifest = JSON.parse(
  readFileSync(resolve(__dirname, '../../package.json'), 'utf8'),
) as Manifest;

/** Expected contract surface — frozen so renames break the build, not silently. */
const EXPECTED_COMMANDS = [
  'agentObservability.refresh',
  'agentObservability.syncNow',
  'agentObservability.openSettings',
  'agentObservability.setApiKey',
  'agentObservability.toggleConsent',
  'agentObservability.previewPayload',
  'agentObservability.openSession',
] as const;

const EXPECTED_VIEWS = [
  'agentObservability.overview',
  'agentObservability.sessions',
  'agentObservability.sync',
] as const;

const EXPECTED_CONFIG_KEYS = [
  'agentObservability.dashboardUrl',
  'agentObservability.sync.enabled',
  'agentObservability.sync.intervalMinutes',
  'agentObservability.localTelemetry.enabled',
  'agentObservability.sqlitePath',
  'agentObservability.deviation.maxSessionMinutes',
  'agentObservability.workflows',
] as const;

describe('manifest contract is stable', () => {
  it('declares the locked identity fields', () => {
    expect(manifest.name).toBe('agent-observability');
    expect(manifest.publisher).toBe('turbinestudios');
    expect(manifest.main).toBe('./dist/extension.js');
    expect(manifest.engines.vscode).toBe('^1.90.0');
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });

  it('contributes exactly the expected commands', () => {
    const ids = manifest.contributes.commands.map((c) => c.command).sort();
    expect(ids).toEqual([...EXPECTED_COMMANDS].sort());
    for (const c of manifest.contributes.commands) {
      expect(c.category).toBe('Agent Observability');
    }
  });

  it('contributes the three views in the activity bar container', () => {
    const container = manifest.contributes.viewsContainers.activitybar;
    expect(container.map((v) => v.id)).toContain('agentObservability');

    const views = manifest.contributes.views.agentObservability.map((v) => v.id);
    // Order matters: Overview, Sessions, Sync.
    expect(views).toEqual([...EXPECTED_VIEWS]);
  });

  it('declares exactly the expected configuration keys with locked defaults', () => {
    const props = manifest.contributes.configuration.properties;
    expect(Object.keys(props).sort()).toEqual([...EXPECTED_CONFIG_KEYS].sort());

    expect(props['agentObservability.dashboardUrl'].default).toBe('');
    expect(props['agentObservability.sync.enabled'].default).toBe(false);
    expect(props['agentObservability.sync.intervalMinutes'].default).toBe(60);
    expect(props['agentObservability.sync.intervalMinutes'].minimum).toBe(5);
    expect(props['agentObservability.localTelemetry.enabled'].default).toBe(true);
    expect(props['agentObservability.sqlitePath'].default).toBe('');
  });
});
