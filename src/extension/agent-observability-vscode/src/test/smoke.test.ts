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
  scope?: string;
  enum?: string[];
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
  'agentObservability.configureSyncRepositories',
  'agentObservability.configureExcludedRepositories',
  'agentObservability.toggleConsent',
  'agentObservability.previewPayload',
  'agentObservability.openSession',
  'agentObservability.openCombinedSession',
  'agentObservability.openRepository',
  'agentObservability.refreshSessionDetail',
  'agentObservability.openAssistant',
  'agentObservability.newChat',
  'agentObservability.enableLiveUpdates',
  'agentObservability.disableLiveUpdates',
  'agentObservability.showLogs',
  'agentObservability.setCloudAccountToken',
  'agentObservability.setAgentRelayToken',
] as const;

const EXPECTED_VIEWS = [
  'agentObservability.overview',
  'agentObservability.sessions',
  'agentObservability.sync',
  'agentObservability.contextHotspots',
  'agentObservability.assistant',
] as const;

const EXPECTED_CONFIG_KEYS = [
  'agentObservability.sync.dashboardUrl',
  'agentObservability.sync.enabled',
  'agentObservability.sync.intervalMinutes',
  'agentObservability.sync.repositoryMode',
  'agentObservability.sync.repositories',
  'agentObservability.excludedRepositories',
  'agentObservability.localTelemetry.enabled',
  'agentObservability.sqlitePath',
  'agentObservability.deviation.maxSessionMinutes',
  'agentObservability.deviation.notifyOnDivergence',
  'agentObservability.context.acceptedMissingFiles',
  'agentObservability.context.acceptedMissingSources',
  'agentObservability.workflows',
  'agentObservability.analysis.codeFileExtensions',
  'agentObservability.analysis.docFileExtensions',
  'agentObservability.liveUpdates.enabled',
  'agentObservability.liveUpdates.debounceMs',
  'agentObservability.liveUpdates.otelPort',
  'agentObservability.copilotArchive.enabled',
  'agentObservability.copilotArchive.path',
  'agentObservability.copilotArchive.retentionDays',
  'agentObservability.copilotArchive.sweepIntervalSeconds',
  'agentObservability.claudeCode.enabled',
  'agentObservability.claudeCode.projectsPath',
  'agentObservability.claudeCode.scanDepth',
  'agentObservability.claudeCode.maxSessions',
  'agentObservability.aiHelper.backend',
  'agentObservability.aiHelper.copilotModel',
  'agentObservability.aiHelper.claudeModel',
  'agentObservability.aiHelper.claudeEffort',
  'agentObservability.aiHelper.claudeCliPath',
  'agentObservability.copilotCloud.enabled',
  'agentObservability.copilotCloud.accounts',
  'agentObservability.copilotCloud.ghCliPath',
  'agentObservability.copilotCloud.idlePollSeconds',
  'agentObservability.copilotCloud.activePollSeconds',
  'agentObservability.copilotCloud.scope',
  'agentObservability.copilotCloud.retentionDays',
  'agentObservability.copilotCloud.maxTasks',
  'agentObservability.copilotAgent.enabled',
  'agentObservability.copilotAgent.endpoint',
  'agentObservability.copilotAgent.idlePollSeconds',
  'agentObservability.copilotAgent.activePollSeconds',
  'agentObservability.copilotAgent.retentionDays',
  'agentObservability.copilotAgent.maxSessions',
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
    // Order matters: Overview, Sessions, Sync, Context Hotspots, AI Helper.
    expect(views).toEqual([...EXPECTED_VIEWS]);
  });

  it('declares exactly the expected configuration keys with locked defaults', () => {
    const props = manifest.contributes.configuration.properties;
    expect(Object.keys(props).sort()).toEqual([...EXPECTED_CONFIG_KEYS].sort());

    expect(props['agentObservability.sync.enabled'].default).toBe(false);
    // The dashboard address decides where the API key goes: empty by default,
    // and never settable from a workspace.
    expect(props['agentObservability.sync.dashboardUrl'].default).toBe('');
    expect(props['agentObservability.sync.dashboardUrl'].scope).toBe('application');
    expect(props['agentObservability.sync.intervalMinutes'].default).toBe(60);
    expect(props['agentObservability.sync.intervalMinutes'].minimum).toBe(5);
    expect(props['agentObservability.localTelemetry.enabled'].default).toBe(true);
    expect(props['agentObservability.sqlitePath'].default).toBe('');
    expect(props['agentObservability.claudeCode.enabled'].default).toBe(true);
    expect(props['agentObservability.claudeCode.maxSessions'].default).toBe(150);
  });

  it('locks the Copilot (Cloud) source off-by-default and privacy-scoped', () => {
    const props = manifest.contributes.configuration.properties;
    // Privacy-relevant default: the cloud source is opt-in (off) — it pulls
    // org-visible data down and stores raw prompts/tool I/O locally.
    expect(props['agentObservability.copilotCloud.enabled'].default).toBe(false);
    expect(props['agentObservability.copilotCloud.accounts'].default).toEqual([]);
    expect(props['agentObservability.copilotCloud.scope'].default).toBe('my-tasks');
    expect(props['agentObservability.copilotCloud.scope'].enum).toEqual(['my-tasks', 'repos']);
    expect(props['agentObservability.copilotCloud.idlePollSeconds'].default).toBe(300);
    expect(props['agentObservability.copilotCloud.idlePollSeconds'].minimum).toBe(60);
    expect(props['agentObservability.copilotCloud.activePollSeconds'].default).toBe(60);
    expect(props['agentObservability.copilotCloud.activePollSeconds'].minimum).toBe(30);
    expect(props['agentObservability.copilotCloud.retentionDays'].default).toBe(180);
    expect(props['agentObservability.copilotCloud.maxTasks'].default).toBe(100);
    // Home-anchored sink = machine-wide, like copilotArchive.* — application scope.
    for (const key of [
      'agentObservability.copilotCloud.enabled',
      'agentObservability.copilotCloud.accounts',
      'agentObservability.copilotCloud.ghCliPath',
      'agentObservability.copilotCloud.idlePollSeconds',
      'agentObservability.copilotCloud.activePollSeconds',
      'agentObservability.copilotCloud.scope',
      'agentObservability.copilotCloud.retentionDays',
      'agentObservability.copilotCloud.maxTasks',
    ]) {
      expect(props[key].scope).toBe('application');
    }
  });

  it('locks the Copilot (Autonomous) source off-by-default and application-scoped', () => {
    const props = manifest.contributes.configuration.properties;
    // Privacy-relevant default: the autonomous-agent source is opt-in (off) — it
    // pulls full gen_ai.* prompts/tool I/O down and stores them raw locally.
    expect(props['agentObservability.copilotAgent.enabled'].default).toBe(false);
    expect(props['agentObservability.copilotAgent.endpoint'].default).toBe('');
    expect(props['agentObservability.copilotAgent.idlePollSeconds'].default).toBe(300);
    expect(props['agentObservability.copilotAgent.idlePollSeconds'].minimum).toBe(60);
    expect(props['agentObservability.copilotAgent.activePollSeconds'].default).toBe(60);
    expect(props['agentObservability.copilotAgent.activePollSeconds'].minimum).toBe(30);
    expect(props['agentObservability.copilotAgent.retentionDays'].default).toBe(180);
    expect(props['agentObservability.copilotAgent.retentionDays'].minimum).toBe(1);
    expect(props['agentObservability.copilotAgent.maxSessions'].default).toBe(100);
    expect(props['agentObservability.copilotAgent.maxSessions'].minimum).toBe(1);
    // Home-anchored sink = machine-wide, like copilotArchive.*/copilotCloud.* — application scope.
    for (const key of [
      'agentObservability.copilotAgent.enabled',
      'agentObservability.copilotAgent.endpoint',
      'agentObservability.copilotAgent.idlePollSeconds',
      'agentObservability.copilotAgent.activePollSeconds',
      'agentObservability.copilotAgent.retentionDays',
      'agentObservability.copilotAgent.maxSessions',
    ]) {
      expect(props[key].scope).toBe('application');
    }
  });

  it('declares the AI Helper backend/model/effort settings, application-scoped', () => {
    const props = manifest.contributes.configuration.properties;
    const backend = props['agentObservability.aiHelper.backend'];
    expect(backend.default).toBe('copilot');
    expect(backend.enum).toEqual(['copilot', 'claude-code']);
    const effort = props['agentObservability.aiHelper.claudeEffort'];
    expect(effort.default).toBe('high');
    expect(effort.enum).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(props['agentObservability.aiHelper.copilotModel'].default).toBe('');
    expect(props['agentObservability.aiHelper.claudeModel'].default).toBe('sonnet');
    expect(props['agentObservability.aiHelper.claudeCliPath'].default).toBe('');
    // Backend/model choices are machine-level (CLI install, Copilot license) — user-scope only.
    for (const key of [
      'agentObservability.aiHelper.backend',
      'agentObservability.aiHelper.copilotModel',
      'agentObservability.aiHelper.claudeModel',
      'agentObservability.aiHelper.claudeEffort',
      'agentObservability.aiHelper.claudeCliPath',
    ]) {
      expect(props[key].scope).toBe('application');
    }
  });

  it('declares the per-repository sync-scope settings, application-scoped', () => {
    const props = manifest.contributes.configuration.properties;
    const mode = props['agentObservability.sync.repositoryMode'];
    const repos = props['agentObservability.sync.repositories'];
    // Default is privacy-first: include-only, so an empty repositories list
    // uploads nothing until the user explicitly picks repositories to share.
    expect(mode.default).toBe('include');
    expect(mode.enum).toEqual(['all', 'include', 'exclude']);
    expect(repos.default).toEqual([]);
    // Scope is inherently cross-workspace, so it must be user-level only.
    expect(mode.scope).toBe('application');
    expect(repos.scope).toBe('application');
  });

  it('declares the hide-repositories setting, empty by default and application-scoped', () => {
    const props = manifest.contributes.configuration.properties;
    const excluded = props['agentObservability.excludedRepositories'];
    // Default is show-everything: nothing is hidden until the user opts repos out.
    expect(excluded.default).toEqual([]);
    expect(excluded.scope).toBe('application');
  });
});

/** Minimal JSON Schema view for drilling into the workflows contribution. */
interface JsonSchema {
  type?: string;
  enum?: string[];
  required?: string[];
  additionalProperties?: boolean;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
}

describe('workflows predicate DSL schema (Phase 1-3)', () => {
  const workflows = manifest.contributes.configuration.properties[
    'agentObservability.workflows'
  ] as unknown as JsonSchema;
  /** The schema of a single workflow object (`workflows[].workflows[]`). */
  const workflowItem = workflows.items?.properties?.workflows?.items;
  const metadataFields = ['operation', 'agentName', 'agentMode', 'model', 'toolName', 'success'];

  it('does not regress the top-level configuration keys', () => {
    const props = manifest.contributes.configuration.properties;
    expect(Object.keys(props).sort()).toEqual([...EXPECTED_CONFIG_KEYS].sort());
  });

  it('declares triggerPredicate + steps alongside the legacy fields, closed to extras', () => {
    expect(workflowItem).toBeDefined();
    const props = Object.keys(workflowItem?.properties ?? {});
    expect(props).toContain('triggerPredicate');
    expect(props).toContain('steps');
    expect(props).toContain('expectedSequence');
    expect(workflowItem?.additionalProperties).toBe(false);
  });

  it('declares the metadata predicate fields on triggerPredicate and step.predicate', () => {
    const trigger = workflowItem?.properties?.triggerPredicate;
    expect(trigger?.additionalProperties).toBe(false);
    for (const f of metadataFields) {
      expect(Object.keys(trigger?.properties ?? {})).toContain(f);
    }
    const predicate = workflowItem?.properties?.steps?.items?.properties?.predicate;
    for (const f of metadataFields) {
      expect(Object.keys(predicate?.properties ?? {})).toContain(f);
    }
  });

  it('declares contentPredicate with an attribute enum restricted to the allow-list', () => {
    const content = workflowItem?.properties?.steps?.items?.properties?.contentPredicate;
    expect(content?.additionalProperties).toBe(false);
    expect(content?.required).toContain('attribute');
    const attrEnum = content?.properties?.attribute?.enum ?? [];
    expect(attrEnum).toContain('copilot_chat.user_request');
    expect(attrEnum).toContain('gen_ai.tool.call.arguments');
    expect(attrEnum).toContain('copilot_chat.mode_name');
    // The aggregate-only marker that is NOT a span attribute must not be offered.
    expect(attrEnum).not.toContain('repositoryBranch');
    for (const key of ['contains', 'matches', 'negate']) {
      expect(Object.keys(content?.properties ?? {})).toContain(key);
    }
  });
});
