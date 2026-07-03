import * as vscode from 'vscode';
import { WorkflowConfig } from '../deviation/models';
import { normalizeExtensions } from '../telemetry/locAnalysis';
import { buildRepoSyncPolicy, normalizeRepositoryList, RepoSyncPolicy } from '../aggregate/repoSyncPolicy';
import { MIN_SESSION_MINUTES, parseWorkflowConfigs } from './workflowParsing';
import { ClaudeEffort, DEFAULT_CLAUDE_MODEL, parseClaudeEffort } from '../chat/backends/claudeCliArgs';
import type { BackendId } from '../chat/backends/chatBackend';

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
  excludedRepositories: 'excludedRepositories',
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
  copilotArchiveEnabled: 'copilotArchive.enabled',
  copilotArchivePath: 'copilotArchive.path',
  copilotArchiveRetentionDays: 'copilotArchive.retentionDays',
  copilotArchiveSweepSeconds: 'copilotArchive.sweepIntervalSeconds',
  claudeEnabled: 'claudeCode.enabled',
  claudeProjectsPath: 'claudeCode.projectsPath',
  claudeScanDepth: 'claudeCode.scanDepth',
  claudeMaxSessions: 'claudeCode.maxSessions',
  aiHelperBackend: 'aiHelper.backend',
  aiHelperCopilotModel: 'aiHelper.copilotModel',
  aiHelperClaudeModel: 'aiHelper.claudeModel',
  aiHelperClaudeEffort: 'aiHelper.claudeEffort',
  aiHelperClaudeCliPath: 'aiHelper.claudeCliPath',
} as const;

/** Default values mirroring the package.json contribution defaults. */
export const ConfigDefaults = {
  syncEnabled: false,
  syncIntervalMinutes: 60,
  syncRepositoryMode: 'include',
  syncRepositories: [] as readonly string[],
  excludedRepositories: [] as readonly string[],
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
  copilotArchiveEnabled: true,
  copilotArchivePath: '',
  copilotArchiveRetentionDays: 180,
  copilotArchiveSweepSeconds: 60,
  claudeEnabled: true,
  claudeProjectsPath: '',
  claudeScanDepth: 8,
  claudeMaxSessions: 150,
  aiHelperBackend: 'copilot',
  aiHelperCopilotModel: '',
  aiHelperClaudeModel: 'sonnet',
  aiHelperClaudeEffort: 'high',
  aiHelperClaudeCliPath: '',
} as const;

/** Minimum allowed sync interval, mirroring the package.json `minimum`. */
export const MIN_SYNC_INTERVAL_MINUTES = 5;

/** Minimum live-update debounce, mirroring the package.json `minimum`. */
export const MIN_LIVE_DEBOUNCE_MS = 100;

/** Minimum archive retention (days) + sweep interval (seconds), mirroring package.json. */
export const MIN_ARCHIVE_RETENTION_DAYS = 1;
export const MIN_ARCHIVE_SWEEP_SECONDS = 10;

/** Milliseconds per day, for the retention conversion. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
   * the machine. Defaults to `include` (privacy-first — with an empty
   * `sync.repositories` list nothing is uploaded until the user picks at least
   * one repository), and a hand-edited invalid mode safely falls back to `all`.
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

  /**
   * Repositories hidden from the WHOLE extension, as a normalized set. Unlike
   * the sync scope (which only narrows what uploads), an excluded repository's
   * sessions disappear from the local views (Overview, Sessions tree, pickers)
   * AND from the aggregate rows the sync engine / payload preview read — as if
   * the repository did not exist. Entries are normalized through the SAME
   * chokepoint as `sync.repositories` (so `org/repo` shorthand or a trailing
   * `.git` still match); the literal `unknown` hides sessions with no detected
   * git remote. Purely a read-time filter: the underlying local telemetry is
   * untouched, so removing an entry brings a repository straight back.
   */
  getExcludedRepositories(): ReadonlySet<string> {
    const raw = this.config().get<unknown>(
      ConfigKeys.excludedRepositories,
      ConfigDefaults.excludedRepositories as unknown as string[],
    );
    const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    return normalizeRepositoryList(list);
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
   * Feature flag: whether the durable Copilot archive is enabled. On by default —
   * the extension sweeps Copilot's short-lived native `agent-traces.db` into a
   * home-anchored archive so sessions persist and appear in every VS Code window
   * (the behavior Claude Code already has). Zero setup; nothing is uploaded.
   */
  isCopilotArchiveEnabled(): boolean {
    return this.config().get<boolean>(
      ConfigKeys.copilotArchiveEnabled,
      ConfigDefaults.copilotArchiveEnabled,
    );
  }

  /**
   * Explicit override of the archive DB file path. Returns `undefined` (not '')
   * when blank so callers fall back to `AGENT_OBSERVABILITY_HOME` /
   * `~/.agent-observability`.
   */
  getCopilotArchivePathOverride(): string | undefined {
    const value = this.config()
      .get<string>(ConfigKeys.copilotArchivePath, ConfigDefaults.copilotArchivePath)
      .trim();
    return value.length > 0 ? value : undefined;
  }

  /**
   * How long the archive retains sessions, as milliseconds. Clamped to the
   * documented minimum so a hand-edited settings.json can't drive a pathological
   * value. Defaults to 180 days — long enough to beat Copilot's short rolling
   * window and approach Claude Code's retention.
   */
  getArchiveRetentionMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotArchiveRetentionDays,
      ConfigDefaults.copilotArchiveRetentionDays,
    );
    const days = Number.isFinite(raw)
      ? Math.max(MIN_ARCHIVE_RETENTION_DAYS, Math.floor(raw))
      : ConfigDefaults.copilotArchiveRetentionDays;
    return days * MS_PER_DAY;
  }

  /**
   * Interval between archive sweeps, as milliseconds, clamped to the documented
   * minimum so a hand-edited settings.json can't drive a busy-loop.
   */
  getArchiveSweepMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotArchiveSweepSeconds,
      ConfigDefaults.copilotArchiveSweepSeconds,
    );
    const seconds = Number.isFinite(raw)
      ? Math.max(MIN_ARCHIVE_SWEEP_SECONDS, Math.floor(raw))
      : ConfigDefaults.copilotArchiveSweepSeconds;
    return seconds * 1000;
  }

  /**
   * Feature flag: whether Claude Code transcript capture is enabled. On by
   * default — Claude Code sessions are read from `~/.claude/projects` and shown
   * alongside Copilot in the unified views.
   */
  isClaudeEnabled(): boolean {
    return this.config().get<boolean>(ConfigKeys.claudeEnabled, ConfigDefaults.claudeEnabled);
  }

  /**
   * Explicit override of the Claude Code `projects` directory. Returns `undefined`
   * (not '') when blank so callers fall back to `CLAUDE_CONFIG_DIR` / `~/.claude`.
   */
  getClaudeProjectsPathOverride(): string | undefined {
    const value = this.config()
      .get<string>(ConfigKeys.claudeProjectsPath, ConfigDefaults.claudeProjectsPath)
      .trim();
    return value.length > 0 ? value : undefined;
  }

  /** Max directory depth to recurse when scanning for Claude transcripts. */
  getClaudeScanDepth(): number {
    const raw = this.config().get<number>(ConfigKeys.claudeScanDepth, ConfigDefaults.claudeScanDepth);
    if (!Number.isFinite(raw)) {
      return ConfigDefaults.claudeScanDepth;
    }
    return Math.max(1, Math.floor(raw));
  }

  /**
   * Max number of most-recent Claude sessions to surface / aggregate by default,
   * bounding the synchronous parse cost. Clamped to a sane floor.
   */
  getClaudeMaxSessions(): number {
    const raw = this.config().get<number>(ConfigKeys.claudeMaxSessions, ConfigDefaults.claudeMaxSessions);
    if (!Number.isFinite(raw) || raw <= 0) {
      return ConfigDefaults.claudeMaxSessions;
    }
    return Math.floor(raw);
  }

  /**
   * Which backend answers AI Helper chats. A hand-edited invalid value safely
   * falls back to `copilot` (the original behavior).
   */
  getAiHelperBackend(): BackendId {
    const raw = this.config().get<string>(ConfigKeys.aiHelperBackend, ConfigDefaults.aiHelperBackend);
    return raw === 'claude-code' ? 'claude-code' : 'copilot';
  }

  /** Preferred Copilot model id/family for the AI Helper; '' = first available. */
  getAiHelperCopilotModel(): string {
    return this.config()
      .get<string>(ConfigKeys.aiHelperCopilotModel, ConfigDefaults.aiHelperCopilotModel)
      .trim();
  }

  /** Claude model (alias or full id) for the AI Helper; blank falls back to the default alias. */
  getAiHelperClaudeModel(): string {
    const value = this.config()
      .get<string>(ConfigKeys.aiHelperClaudeModel, ConfigDefaults.aiHelperClaudeModel)
      .trim();
    return value.length > 0 ? value : DEFAULT_CLAUDE_MODEL;
  }

  /** Reasoning effort for the Claude Code CLI; invalid values fall back to the default. */
  getAiHelperClaudeEffort(): ClaudeEffort {
    return parseClaudeEffort(
      this.config().get<string>(ConfigKeys.aiHelperClaudeEffort, ConfigDefaults.aiHelperClaudeEffort),
    );
  }

  /** Claude Code CLI executable; blank falls back to `claude` on PATH. */
  getAiHelperClaudeCliPath(): string {
    const value = this.config()
      .get<string>(ConfigKeys.aiHelperClaudeCliPath, ConfigDefaults.aiHelperClaudeCliPath)
      .trim();
    return value.length > 0 ? value : 'claude';
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
