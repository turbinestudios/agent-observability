import { WorkflowConfig } from '../deviation/models';
import { normalizeExtensions } from '../telemetry/locAnalysis';
import { buildRepoSyncPolicy, normalizeRepositoryList, RepoSyncPolicy } from '../aggregate/repoSyncPolicy';
import { MIN_SESSION_MINUTES, parseWorkflowConfigs } from './workflowParsing';
import { ClaudeEffort, DEFAULT_CLAUDE_MODEL, parseClaudeEffort } from '../chat/backends/claudeCliArgs';
import { DEFAULT_COPILOT_CLI_MODEL } from '../chat/backends/copilotCliArgs';
import type { BackendId } from '../chat/backends/chatBackend';

export { MIN_SESSION_MINUTES } from './workflowParsing';

/**
 * The configuration section under which all extension settings live. This must
 * match the `agentObservability.*` keys declared in package.json `contributes`.
 */
export const CONFIG_SECTION = 'agentObservability';

/**
 * Normalize the user's dashboard address: trimmed, and only an `https:` URL is
 * accepted. Anything else (empty, `http:`, unparseable) yields `''`, which the
 * sync engine reports as "misconfigured" rather than sending the API key over a
 * plain or malformed connection. A trailing slash is dropped so endpoint paths
 * join cleanly.
 */
export function normalizeDashboardUrl(raw: unknown): string {
  if (typeof raw !== 'string') {
    return '';
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return '';
  }
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:') {
      return '';
    }
  } catch {
    return '';
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * Stable, fully-qualified configuration key constants.
 *
 * These are the single source of truth for setting ids and are referenced by
 * the smoke test to guard against accidental renames (later phases depend on
 * these exact keys — e.g. the sync engine reads `sync.enabled`).
 */
export const ConfigKeys = {
  syncDashboardUrl: 'sync.dashboardUrl',
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
  copilotCliEnabled: 'copilotCli.enabled',
  copilotAppEnabled: 'copilotApp.enabled',
  copilotJetbrainsEnabled: 'copilotJetbrains.enabled',
  copilotJetbrainsStorePath: 'copilotJetbrains.storePath',
  claudeProjectsPath: 'claudeCode.projectsPath',
  claudeScanDepth: 'claudeCode.scanDepth',
  claudeMaxSessions: 'claudeCode.maxSessions',
  aiHelperBackend: 'aiHelper.backend',
  aiHelperCopilotModel: 'aiHelper.copilotModel',
  aiHelperClaudeModel: 'aiHelper.claudeModel',
  aiHelperClaudeEffort: 'aiHelper.claudeEffort',
  aiHelperClaudeCliPath: 'aiHelper.claudeCliPath',
  aiHelperCopilotCliModel: 'aiHelper.copilotCliModel',
  aiHelperCopilotCliPath: 'aiHelper.copilotCliPath',
  copilotCloudEnabled: 'copilotCloud.enabled',
  copilotCloudAccounts: 'copilotCloud.accounts',
  copilotCloudGhCliPath: 'copilotCloud.ghCliPath',
  copilotCloudIdlePollSeconds: 'copilotCloud.idlePollSeconds',
  copilotCloudActivePollSeconds: 'copilotCloud.activePollSeconds',
  copilotCloudScope: 'copilotCloud.scope',
  copilotCloudRetentionDays: 'copilotCloud.retentionDays',
  copilotCloudMaxTasks: 'copilotCloud.maxTasks',
  copilotAgentEnabled: 'copilotAgent.enabled',
  copilotAgentEndpoint: 'copilotAgent.endpoint',
  copilotAgentIdlePollSeconds: 'copilotAgent.idlePollSeconds',
  copilotAgentActivePollSeconds: 'copilotAgent.activePollSeconds',
  copilotAgentRetentionDays: 'copilotAgent.retentionDays',
  copilotAgentMaxSessions: 'copilotAgent.maxSessions',
} as const;

/** Default values mirroring the package.json contribution defaults. */
export const ConfigDefaults = {
  syncDashboardUrl: '',
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
  copilotCliEnabled: true,
  copilotAppEnabled: true,
  copilotJetbrainsEnabled: true,
  copilotJetbrainsStorePath: '',
  claudeProjectsPath: '',
  claudeScanDepth: 8,
  claudeMaxSessions: 150,
  aiHelperBackend: 'copilot',
  aiHelperCopilotModel: '',
  aiHelperClaudeModel: 'sonnet',
  aiHelperClaudeEffort: 'high',
  aiHelperClaudeCliPath: '',
  aiHelperCopilotCliModel: '',
  aiHelperCopilotCliPath: '',
  copilotCloudEnabled: false,
  copilotCloudAccounts: [] as readonly string[],
  copilotCloudGhCliPath: '',
  copilotCloudIdlePollSeconds: 300,
  copilotCloudActivePollSeconds: 60,
  copilotCloudScope: 'my-tasks',
  copilotCloudRetentionDays: 180,
  copilotCloudMaxTasks: 100,
  copilotAgentEnabled: false,
  copilotAgentEndpoint: '',
  copilotAgentIdlePollSeconds: 300,
  copilotAgentActivePollSeconds: 60,
  copilotAgentRetentionDays: 180,
  copilotAgentMaxSessions: 100,
} as const;

/** Minimum allowed sync interval, mirroring the package.json `minimum`. */
export const MIN_SYNC_INTERVAL_MINUTES = 5;

/** Minimum live-update debounce, mirroring the package.json `minimum`. */
export const MIN_LIVE_DEBOUNCE_MS = 100;

/** Minimum archive retention (days) + sweep interval (seconds), mirroring package.json. */
export const MIN_ARCHIVE_RETENTION_DAYS = 1;
export const MIN_ARCHIVE_SWEEP_SECONDS = 10;

/** Minimum Copilot (Cloud) poll intervals (seconds) + retention (days), mirroring package.json. */
export const MIN_COPILOT_CLOUD_IDLE_POLL_SECONDS = 60;
export const MIN_COPILOT_CLOUD_ACTIVE_POLL_SECONDS = 30;
export const MIN_COPILOT_CLOUD_RETENTION_DAYS = 1;

/** Minimum Copilot (Autonomous) poll intervals (seconds) + retention (days), mirroring package.json. */
export const MIN_COPILOT_AGENT_IDLE_POLL_SECONDS = 60;
export const MIN_COPILOT_AGENT_ACTIVE_POLL_SECONDS = 30;
export const MIN_COPILOT_AGENT_RETENTION_DAYS = 1;

/** Milliseconds per day, for the retention conversion. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Something that can be unsubscribed. `vscode.Disposable` satisfies this. */
export interface SettingsSubscription {
  dispose(): unknown;
}

/**
 * The host's settings store, read one key at a time.
 *
 * This is the only thing {@link Configuration} needs from its host, which is
 * what keeps the whole typed-accessor layer host-independent: the extension
 * backs it with `vscode.workspace.getConfiguration`, the desktop app with a
 * JSON file. Keys are section-relative (e.g. `sync.enabled`), matching
 * {@link ConfigKeys}.
 */
export interface SettingsReader {
  /** Read a setting, returning `defaultValue` when unset. */
  get<T>(key: string, defaultValue: T): T;
  /** Subscribe to changes affecting this section. */
  onDidChange(listener: () => void): SettingsSubscription;
}

/**
 * Typed accessor over the `agentObservability` configuration.
 *
 * This is the seam through which all of the extension reads settings. Keeping
 * reads centralized means the sync engine, SQLite adapter, and aggregate engine
 * never touch the host's settings API directly and never hard-code setting ids.
 */
export class Configuration {
  constructor(private readonly settings: SettingsReader) {}

  private config(): SettingsReader {
    // Read fresh each time so changes apply without caching staleness; callers
    // that need to react to changes should listen to onDidChange (below).
    return this.settings;
  }

  /**
   * The team dashboard's base URL, or `''` when unset or not `https:`.
   *
   * The extension declares this setting with `application` scope, so only the
   * user's own settings can set it. A workspace or folder `settings.json` can
   * never redirect the bearer API key to another host.
   */
  getDashboardUrl(): string {
    return normalizeDashboardUrl(
      this.config().get<string>(ConfigKeys.syncDashboardUrl, ConfigDefaults.syncDashboardUrl),
    );
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
   * Whether Copilot CLI sessions (`~/.copilot/session-state`) are read. Local
   * and read-only like the other sources; on by default.
   */
  isCopilotCliEnabled(): boolean {
    return this.config().get<boolean>(ConfigKeys.copilotCliEnabled, ConfigDefaults.copilotCliEnabled);
  }

  /**
   * Whether sessions from the GitHub Copilot app are read. The app runs the
   * same runtime and writes the same store as the CLI; its sessions are told
   * apart by `client_name` and listed as their own source. On by default.
   */
  isCopilotAppEnabled(): boolean {
    return this.config().get<boolean>(ConfigKeys.copilotAppEnabled, ConfigDefaults.copilotAppEnabled);
  }

  /** Whether Copilot chats from JetBrains IDEs (Rider, IntelliJ, …) are read. On by default. */
  isCopilotJetbrainsEnabled(): boolean {
    return this.config().get<boolean>(ConfigKeys.copilotJetbrainsEnabled, ConfigDefaults.copilotJetbrainsEnabled);
  }

  /**
   * Explicit override of the Copilot JetBrains plugin's store root (the
   * folder holding `<ide>/chat-*-sessions/`). `undefined` when unset, so the
   * platform default is used.
   */
  getCopilotJetbrainsStorePath(): string | undefined {
    const value = this.config()
      .get<string>(ConfigKeys.copilotJetbrainsStorePath, ConfigDefaults.copilotJetbrainsStorePath)
      .trim();
    return value.length > 0 ? value : undefined;
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
    return raw === 'claude-code' || raw === 'copilot-cli' ? raw : 'copilot';
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

  /** Copilot CLI model id; blank falls back to `auto` (the CLI picks). */
  getAiHelperCopilotCliModel(): string {
    const value = this.config()
      .get<string>(ConfigKeys.aiHelperCopilotCliModel, ConfigDefaults.aiHelperCopilotCliModel)
      .trim();
    return value.length > 0 ? value : DEFAULT_COPILOT_CLI_MODEL;
  }

  /** Copilot CLI executable; blank falls back to `copilot` on PATH. */
  getAiHelperCopilotCliPath(): string {
    const value = this.config()
      .get<string>(ConfigKeys.aiHelperCopilotCliPath, ConfigDefaults.aiHelperCopilotCliPath)
      .trim();
    return value.length > 0 ? value : 'copilot';
  }

  /**
   * Feature flag: whether the Copilot **cloud** coding-agent source is enabled.
   * Opt-in (off by default). When on, a background poller pulls cloud-agent
   * task/session logs (via the `gh` CLI or a per-account PAT) into a local sink
   * and folds them into the unified views as the **Copilot (Cloud)** source.
   */
  isCopilotCloudEnabled(): boolean {
    return this.config().get<boolean>(
      ConfigKeys.copilotCloudEnabled,
      ConfigDefaults.copilotCloudEnabled,
    );
  }

  /**
   * The gh usernames whose cloud-agent tasks to poll — a trimmed, de-duplicated,
   * non-empty list. Empty means "no accounts pinned yet" (nothing is polled; the
   * source captures the active login on first enable). Identities are pinned here
   * rather than following `gh auth switch`.
   */
  getCopilotCloudAccounts(): string[] {
    const raw = this.config().get<unknown>(
      ConfigKeys.copilotCloudAccounts,
      ConfigDefaults.copilotCloudAccounts as unknown as string[],
    );
    const list = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of list) {
      const trimmed = entry.trim();
      if (trimmed.length > 0 && !seen.has(trimmed)) {
        seen.add(trimmed);
        out.push(trimmed);
      }
    }
    return out;
  }

  /** GitHub CLI executable used to mint account tokens; blank falls back to `gh` on PATH. */
  getCopilotCloudGhCliPath(): string {
    const value = this.config()
      .get<string>(ConfigKeys.copilotCloudGhCliPath, ConfigDefaults.copilotCloudGhCliPath)
      .trim();
    return value.length > 0 ? value : 'gh';
  }

  /**
   * Poll interval (ms) while no cloud task is actively running. Clamped to the
   * documented minimum so a hand-edited settings.json cannot drive a busy-loop.
   */
  getCopilotCloudIdlePollMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotCloudIdlePollSeconds,
      ConfigDefaults.copilotCloudIdlePollSeconds,
    );
    const seconds = Number.isFinite(raw)
      ? Math.max(MIN_COPILOT_CLOUD_IDLE_POLL_SECONDS, Math.floor(raw))
      : ConfigDefaults.copilotCloudIdlePollSeconds;
    return seconds * 1000;
  }

  /** Poll interval (ms) while a cloud task is actively running (faster), clamped to the minimum. */
  getCopilotCloudActivePollMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotCloudActivePollSeconds,
      ConfigDefaults.copilotCloudActivePollSeconds,
    );
    const seconds = Number.isFinite(raw)
      ? Math.max(MIN_COPILOT_CLOUD_ACTIVE_POLL_SECONDS, Math.floor(raw))
      : ConfigDefaults.copilotCloudActivePollSeconds;
    return seconds * 1000;
  }

  /**
   * Which cloud tasks to fetch: `my-tasks` (only the authenticated user's own
   * tasks — privacy-first default) or `repos` (teammates' tasks in the workspace
   * repos, Phase 3). A hand-edited invalid value falls back to `my-tasks`.
   */
  getCopilotCloudScope(): 'my-tasks' | 'repos' {
    const raw = this.config().get<string>(
      ConfigKeys.copilotCloudScope,
      ConfigDefaults.copilotCloudScope,
    );
    return raw === 'repos' ? 'repos' : 'my-tasks';
  }

  /** How long polled cloud tasks are retained, as milliseconds. Clamped to the minimum. */
  getCopilotCloudRetentionMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotCloudRetentionDays,
      ConfigDefaults.copilotCloudRetentionDays,
    );
    const days = Number.isFinite(raw)
      ? Math.max(MIN_COPILOT_CLOUD_RETENTION_DAYS, Math.floor(raw))
      : ConfigDefaults.copilotCloudRetentionDays;
    return days * MS_PER_DAY;
  }

  /** Max most-recent cloud tasks to surface / poll per account (positive-int floor). */
  getCopilotCloudMaxTasks(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotCloudMaxTasks,
      ConfigDefaults.copilotCloudMaxTasks,
    );
    if (!Number.isFinite(raw) || raw <= 0) {
      return ConfigDefaults.copilotCloudMaxTasks;
    }
    return Math.floor(raw);
  }

  /** Whether the Copilot (Autonomous) source pulls autonomous-agent OTLP from the relay. */
  isCopilotAgentEnabled(): boolean {
    return this.config().get<boolean>(
      ConfigKeys.copilotAgentEnabled,
      ConfigDefaults.copilotAgentEnabled,
    );
  }

  /**
   * Base URL of the cloud landing spot autonomous-agent OTLP is pulled from.
   * Blank (the default) leaves the source inert — `undefined` so nothing is pulled.
   */
  getCopilotAgentEndpoint(): string | undefined {
    const value = this.config()
      .get<string>(ConfigKeys.copilotAgentEndpoint, ConfigDefaults.copilotAgentEndpoint)
      .trim();
    return value.length > 0 ? value : undefined;
  }

  /**
   * Poll interval (ms) while no agent batch arrived on the previous poll. Clamped
   * to the documented minimum so a hand-edited settings.json cannot busy-loop.
   */
  getCopilotAgentIdlePollMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotAgentIdlePollSeconds,
      ConfigDefaults.copilotAgentIdlePollSeconds,
    );
    const seconds = Number.isFinite(raw)
      ? Math.max(MIN_COPILOT_AGENT_IDLE_POLL_SECONDS, Math.floor(raw))
      : ConfigDefaults.copilotAgentIdlePollSeconds;
    return seconds * 1000;
  }

  /** Poll interval (ms) right after a poll that pulled new agent batches, clamped to the minimum. */
  getCopilotAgentActivePollMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotAgentActivePollSeconds,
      ConfigDefaults.copilotAgentActivePollSeconds,
    );
    const seconds = Number.isFinite(raw)
      ? Math.max(MIN_COPILOT_AGENT_ACTIVE_POLL_SECONDS, Math.floor(raw))
      : ConfigDefaults.copilotAgentActivePollSeconds;
    return seconds * 1000;
  }

  /** How long ingested agent spans + archived raw batches are retained, as ms. Clamped to the minimum. */
  getCopilotAgentRetentionMs(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotAgentRetentionDays,
      ConfigDefaults.copilotAgentRetentionDays,
    );
    const days = Number.isFinite(raw)
      ? Math.max(MIN_COPILOT_AGENT_RETENTION_DAYS, Math.floor(raw))
      : ConfigDefaults.copilotAgentRetentionDays;
    return days * MS_PER_DAY;
  }

  /** Max agent batches pulled in one poll (back-pressure against a backlog; positive-int floor). */
  getCopilotAgentMaxSessions(): number {
    const raw = this.config().get<number>(
      ConfigKeys.copilotAgentMaxSessions,
      ConfigDefaults.copilotAgentMaxSessions,
    );
    if (!Number.isFinite(raw) || raw <= 0) {
      return ConfigDefaults.copilotAgentMaxSessions;
    }
    return Math.floor(raw);
  }

  /**
   * Subscribe to changes affecting this extension's configuration section.
   * Returns a disposable; the callback fires only when an `agentObservability.*`
   * key changes (the host's {@link SettingsReader} applies that filter).
   */
  onDidChange(listener: () => void): SettingsSubscription {
    return this.settings.onDidChange(listener);
  }
}
