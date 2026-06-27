import * as vscode from 'vscode';
import { WorkflowConfig } from '../deviation/models';
import { normalizeExtensions } from '../telemetry/locAnalysis';
import { buildRepoSyncPolicy, RepoSyncPolicy } from '../aggregate/repoSyncPolicy';
import { MIN_SESSION_MINUTES, parseWorkflowConfigs } from './workflowParsing';

export { MIN_SESSION_MINUTES } from './workflowParsing';

/**
 * The configuration section under which all extension settings live. This must
 * match the `agentObservability.*` keys declared in package.json `contributes`.
 */
export const CONFIG_SECTION = 'agentObservability';

/**
 * Built-in cloud ingestion base URL — the dashboard deployed to Azure.
 *
 * This is intentionally NOT a user setting: hard-coding it means aggregate
 * uploads always target the org dashboard and a workspace can never redirect the
 * bearer API key to an arbitrary host. Uploads remain gated on consent + a stored
 * API key, so baking in the URL only removes the endpoint-configuration step.
 */
export const DASHBOARD_INGESTION_URL =
  'https://ca-ao-dashboard.example.swedencentral.azurecontainerapps.io';

/**
 * Stable, fully-qualified configuration key constants.
 *
 * These are the single source of truth for setting ids and are referenced by
 * the smoke test to guard against accidental renames (later phases depend on
 * these exact keys — e.g. the sync engine reads `sync.enabled`).
 */
export const ConfigKeys = {
  syncEnabled: 'sync.enabled',
  syncIntervalMinutes: 'sync.intervalMinutes',
  syncRepositoryMode: 'sync.repositoryMode',
  syncRepositories: 'sync.repositories',
  localTelemetryEnabled: 'localTelemetry.enabled',
  sqlitePath: 'sqlitePath',
  maxSessionMinutes: 'deviation.maxSessionMinutes',
  notifyOnDivergence: 'deviation.notifyOnDivergence',
  workflows: 'workflows',
  analysisCodeFileExtensions: 'analysis.codeFileExtensions',
  analysisDocFileExtensions: 'analysis.docFileExtensions',
  liveUpdatesEnabled: 'liveUpdates.enabled',
  liveDebounceMs: 'liveUpdates.debounceMs',
  liveOtelPort: 'liveUpdates.otelPort',
} as const;

/** Default values mirroring the package.json contribution defaults. */
export const ConfigDefaults = {
  syncEnabled: false,
  syncIntervalMinutes: 60,
  syncRepositoryMode: 'all',
  syncRepositories: [] as readonly string[],
  localTelemetryEnabled: true,
  sqlitePath: '',
  maxSessionMinutes: 60,
  notifyOnDivergence: false,
  analysisCodeFileExtensions: [
    '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.java', '.c',
    '.cc', '.cpp', '.h', '.hpp', '.cs', '.go', '.rs', '.rb', '.php',
    '.swift', '.kt', '.kts', '.scala', '.sh', '.bash', '.ps1', '.sql',
    '.css', '.scss', '.sass', '.less', '.html', '.vue', '.svelte',
    '.json', '.yaml', '.yml', '.toml', '.xml', '.gradle', '.dart', '.lua', '.r',
  ] as readonly string[],
  analysisDocFileExtensions: [
    '.md', '.mdx', '.markdown', '.rst', '.txt', '.adoc', '.asciidoc',
  ] as readonly string[],
  liveUpdatesEnabled: false,
  liveDebounceMs: 400,
  liveOtelPort: 0,
} as const;

/** Minimum allowed sync interval, mirroring the package.json `minimum`. */
export const MIN_SYNC_INTERVAL_MINUTES = 5;

/** Minimum live-update debounce, mirroring the package.json `minimum`. */
export const MIN_LIVE_DEBOUNCE_MS = 100;

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

  /** Built-in cloud ingestion base URL (the deployed Azure dashboard). */
  getDashboardUrl(): string {
    return DASHBOARD_INGESTION_URL;
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

  /**
   * Per-repository sync scoping policy. Resolves the `sync.repositoryMode` +
   * `sync.repositories` settings into a normalized {@link RepoSyncPolicy} the
   * sync engine and preview apply to decide which repositories' aggregates leave
   * the machine. Defaults to `all` (every repository — the historical behavior),
   * and a hand-edited invalid mode safely falls back to `all`.
   */
  getRepoSyncPolicy(): RepoSyncPolicy {
    const mode = this.config().get<string>(
      ConfigKeys.syncRepositoryMode,
      ConfigDefaults.syncRepositoryMode,
    );
    const raw = this.config().get<unknown>(
      ConfigKeys.syncRepositories,
      ConfigDefaults.syncRepositories as unknown as string[],
    );
    const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    return buildRepoSyncPolicy(mode, list);
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
   * Whether to raise a VS Code notification when a configured workflow diverges
   * within a user-request turn (a step skipped or out of order). Off by default;
   * the per-turn divergences are always shown inline in the session-detail
   * timeline regardless of this flag.
   */
  isNotifyOnDivergenceEnabled(): boolean {
    return this.config().get<boolean>(
      ConfigKeys.notifyOnDivergence,
      ConfigDefaults.notifyOnDivergence,
    );
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
   * File extensions counted as SOURCE CODE for the local session-detail
   * Lines-of-Code metric (LoC / nLoC), normalized to lowercase, deduplicated,
   * and dot-prefixed. Used only to classify lines the agent wrote/removed; the
   * raw tool arguments they are derived from never leave the machine.
   */
  getCodeFileExtensions(): string[] {
    const raw = this.config().get<unknown>(
      ConfigKeys.analysisCodeFileExtensions,
      ConfigDefaults.analysisCodeFileExtensions as unknown as string[],
    );
    return normalizeExtensions(raw);
  }

  /**
   * File extensions counted as DOCUMENTATION for the local session-detail
   * Lines-of-Documentation metric (LoD / nLoD), normalized like
   * {@link getCodeFileExtensions}.
   */
  getDocFileExtensions(): string[] {
    const raw = this.config().get<unknown>(
      ConfigKeys.analysisDocFileExtensions,
      ConfigDefaults.analysisDocFileExtensions as unknown as string[],
    );
    return normalizeExtensions(raw);
  }

  /**
   * Whether near-real-time live updates are enabled: run a localhost OTLP receiver
   * that Copilot's `otlp-http` exporter pushes spans to, ingest them into the
   * extension's own DB, and refresh the views live. Off by default; the **Enable
   * Live Updates** command flips this and configures Copilot's `otel.*` settings.
   */
  isLiveUpdatesEnabled(): boolean {
    return this.config().get<boolean>(
      ConfigKeys.liveUpdatesEnabled,
      ConfigDefaults.liveUpdatesEnabled,
    );
  }

  /**
   * Debounce (ms) between a file-change signal and the incremental tail read,
   * clamped to the documented minimum so a hand-edited settings.json can't drive
   * a pathological busy-loop.
   */
  getLiveDebounceMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.liveDebounceMs,
      ConfigDefaults.liveDebounceMs,
    );
    if (!Number.isFinite(raw)) {
      return ConfigDefaults.liveDebounceMs;
    }
    return Math.max(MIN_LIVE_DEBOUNCE_MS, Math.floor(raw));
  }

  /**
   * Localhost port the live-OTLP receiver listens on, written by the Enable Live
   * Updates command. `0` (the default) means "not configured yet". Clamped to a
   * valid TCP port range; anything else falls back to 0.
   */
  getLiveOtelPort(): number {
    const raw = this.config().get<number>(ConfigKeys.liveOtelPort, ConfigDefaults.liveOtelPort);
    return Number.isFinite(raw) && raw > 0 && raw < 65536 ? Math.floor(raw) : 0;
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
