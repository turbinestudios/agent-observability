import * as vscode from 'vscode';
import { WorkflowConfig } from '../deviation/models';
import { MIN_SESSION_MINUTES, parseWorkflowConfigs } from './workflowParsing';

export { MIN_SESSION_MINUTES } from './workflowParsing';

/**
 * The configuration section under which all extension settings live. This must
 * match the `agentObservability.*` keys declared in package.json `contributes`.
 */
export const CONFIG_SECTION = 'agentObservability';

/**
 * Stable, fully-qualified configuration key constants.
 *
 * These are the single source of truth for setting ids and are referenced by
 * the smoke test to guard against accidental renames (later phases depend on
 * these exact keys — e.g. the sync engine reads `sync.enabled`).
 */
export const ConfigKeys = {
  dashboardUrl: 'dashboardUrl',
  syncEnabled: 'sync.enabled',
  syncIntervalMinutes: 'sync.intervalMinutes',
  localTelemetryEnabled: 'localTelemetry.enabled',
  sqlitePath: 'sqlitePath',
  maxSessionMinutes: 'deviation.maxSessionMinutes',
  workflows: 'workflows',
} as const;

/** Default values mirroring the package.json contribution defaults. */
export const ConfigDefaults = {
  dashboardUrl: '',
  syncEnabled: false,
  syncIntervalMinutes: 60,
  localTelemetryEnabled: true,
  sqlitePath: '',
  maxSessionMinutes: 60,
} as const;

/** Minimum allowed sync interval, mirroring the package.json `minimum`. */
export const MIN_SYNC_INTERVAL_MINUTES = 5;

/**
 * Typed accessor over the `agentObservability` workspace configuration.
 *
 * This is the seam through which all of the extension reads settings. Keeping
 * reads centralized means later phases (sync engine, SQLite adapter, aggregate
 * engine) never touch `vscode.workspace.getConfiguration` directly and never
 * hard-code setting ids.
 */
export class Configuration {
  private config(): vscode.WorkspaceConfiguration {
    // Read fresh each time so changes apply without caching staleness; callers
    // that need to react to changes should listen to onDidChange (below).
    return vscode.workspace.getConfiguration(CONFIG_SECTION);
  }

  /** Cloud ingestion base URL. Blank means uploads are disabled. */
  getDashboardUrl(): string {
    return this.config().get<string>(ConfigKeys.dashboardUrl, ConfigDefaults.dashboardUrl).trim();
  }

  /** Whether the user has opted in to cloud aggregate sharing (opt-out default). */
  isSyncEnabled(): boolean {
    return this.config().get<boolean>(ConfigKeys.syncEnabled, ConfigDefaults.syncEnabled);
  }

  /**
   * Background sync interval in minutes, clamped to the documented minimum so
   * downstream timers can trust the value even if a user edits settings.json
   * by hand below the declared `minimum`.
   */
  getSyncIntervalMinutes(): number {
    const raw = this.config().get<number>(
      ConfigKeys.syncIntervalMinutes,
      ConfigDefaults.syncIntervalMinutes,
    );
    if (!Number.isFinite(raw)) {
      return ConfigDefaults.syncIntervalMinutes;
    }
    return Math.max(MIN_SYNC_INTERVAL_MINUTES, Math.floor(raw));
  }

  /** Feature flag: whether the local telemetry view is enabled. */
  isLocalTelemetryEnabled(): boolean {
    return this.config().get<boolean>(
      ConfigKeys.localTelemetryEnabled,
      ConfigDefaults.localTelemetryEnabled,
    );
  }

  /**
   * Explicit override path to the Copilot `agent-traces.db`. Returns `undefined`
   * (not an empty string) when blank, so callers can fall back to platform
   * auto-detection without an empty-string special case.
   */
  getSqlitePathOverride(): string | undefined {
    const value = this.config().get<string>(ConfigKeys.sqlitePath, ConfigDefaults.sqlitePath).trim();
    return value.length > 0 ? value : undefined;
  }

  /**
   * Maximum expected agent-session duration in minutes for the local deviation
   * detector, clamped to the documented minimum so downstream code can trust
   * the value even if settings.json is edited below the declared `minimum`.
   */
  getMaxSessionMinutes(): number {
    const raw = this.config().get<number>(
      ConfigKeys.maxSessionMinutes,
      ConfigDefaults.maxSessionMinutes,
    );
    if (!Number.isFinite(raw)) {
      return ConfigDefaults.maxSessionMinutes;
    }
    return Math.max(MIN_SESSION_MINUTES, Math.floor(raw));
  }

  /**
   * Explicit per-repository workflow configurations for the local deviation
   * detector, parsed and normalized from `agentObservability.workflows`.
   *
   * Per-workflow `maxDurationMinutes` falls back to
   * {@link getMaxSessionMinutes}; the three alert flags default to `true`
   * (matching the package.json item defaults). Malformed entries (missing
   * repository/name, non-array workflows) are skipped rather than throwing, so
   * a hand-edited settings.json can never break the detail panel. Durations are
   * normalized to milliseconds for the detector.
   */
  getWorkflowConfigs(): WorkflowConfig[] {
    const raw = this.config().get<unknown>(ConfigKeys.workflows, []);
    return parseWorkflowConfigs(raw, this.getMaxSessionMinutes() * 60_000);
  }

  /**
   * Subscribe to changes affecting this extension's configuration section.
   * Returns a disposable; the callback fires only when an `agentObservability.*`
   * key changes.
   */
  onDidChange(listener: () => void): vscode.Disposable {
    return vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_SECTION)) {
        listener();
      }
    });
  }
}
