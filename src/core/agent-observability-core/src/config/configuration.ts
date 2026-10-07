import { WorkflowConfig } from '../deviation/models';
import { normalizeExtensions } from '../telemetry/locAnalysis';
import { normalizeRepositoryList } from '../aggregate/repoSyncPolicy';
import { MIN_SESSION_MINUTES, parseWorkflowConfigs } from './workflowParsing';
import { ClaudeEffort, DEFAULT_CLAUDE_MODEL, parseClaudeEffort } from '../chat/backends/claudeCliArgs';
import { DEFAULT_COPILOT_CLI_MODEL } from '../chat/backends/copilotCliArgs';
import type { BackendId } from '../chat/backends/chatBackend';

export { MIN_SESSION_MINUTES } from './workflowParsing';

/** The configuration section under which all settings live (`agentObservability.*`). */
export const CONFIG_SECTION = 'agentObservability';

/**
 * Stable, fully-qualified configuration key constants.
 *
 * These are the single source of truth for setting ids and are referenced by
 * the tests to guard against accidental renames.
 */
export const ConfigKeys = {
  excludedRepositories: 'excludedRepositories',
  localTelemetryEnabled: 'localTelemetry.enabled',
  sqlitePath: 'sqlitePath',
  maxSessionMinutes: 'deviation.maxSessionMinutes',
  workflows: 'workflows',
  analysisCodeFileExtensions: 'analysis.codeFileExtensions',
  analysisDocFileExtensions: 'analysis.docFileExtensions',
  copilotArchivePath: 'copilotArchive.path',
  claudeEnabled: 'claudeCode.enabled',
  copilotCliEnabled: 'copilotCli.enabled',
  copilotAppEnabled: 'copilotApp.enabled',
  copilotJetbrainsEnabled: 'copilotJetbrains.enabled',
  copilotJetbrainsStorePath: 'copilotJetbrains.storePath',
  claudeProjectsPath: 'claudeCode.projectsPath',
  claudeScanDepth: 'claudeCode.scanDepth',
  claudeMaxSessions: 'claudeCode.maxSessions',
  aiHelperBackend: 'aiHelper.backend',
  aiHelperClaudeModel: 'aiHelper.claudeModel',
  aiHelperClaudeEffort: 'aiHelper.claudeEffort',
  aiHelperClaudeCliPath: 'aiHelper.claudeCliPath',
  aiHelperCopilotCliModel: 'aiHelper.copilotCliModel',
  aiHelperCopilotCliPath: 'aiHelper.copilotCliPath',
} as const;

/** Default values for each key in {@link ConfigKeys}. */
export const ConfigDefaults = {
  excludedRepositories: [] as readonly string[],
  localTelemetryEnabled: true,
  sqlitePath: '',
  maxSessionMinutes: 60,
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
  copilotArchivePath: '',
  claudeEnabled: true,
  copilotCliEnabled: true,
  copilotAppEnabled: true,
  copilotJetbrainsEnabled: true,
  copilotJetbrainsStorePath: '',
  claudeProjectsPath: '',
  claudeScanDepth: 8,
  claudeMaxSessions: 150,
  aiHelperBackend: 'copilot',
  aiHelperClaudeModel: 'sonnet',
  aiHelperClaudeEffort: 'high',
  aiHelperClaudeCliPath: '',
  aiHelperCopilotCliModel: '',
  aiHelperCopilotCliPath: '',
} as const;

/** Something that can be unsubscribed. */
export interface SettingsSubscription {
  dispose(): unknown;
}

/**
 * The host's settings store, read one key at a time.
 *
 * This is the only thing {@link Configuration} needs from its host, which is
 * what keeps the whole typed-accessor layer host-independent: the desktop app
 * backs it with a JSON file. Keys are section-relative (e.g. `claudeCode.enabled`), matching
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
 * This is the seam through which core reads settings. Keeping reads
 * centralized means the SQLite adapter, session sources and aggregate engine
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
   * Repositories hidden from the WHOLE app, as a normalized set. An excluded
   * repository's sessions disappear from the local views (Overview, Sessions,
   * pickers) AND from the aggregate rows the team shard is built from — as if
   * the repository did not exist. Entries are normalized through the SAME
   * chokepoint as the team repository scope (so `org/repo` shorthand or a trailing
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
   * Explicit per-repository workflow configurations for the local deviation
   * detector, parsed and normalized from `agentObservability.workflows`.
   *
   * Per-workflow `maxDurationMinutes` falls back to
   * {@link getMaxSessionMinutes}; the three alert flags default to `true`.
   * Malformed entries (missing
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
   * Subscribe to changes affecting the configuration section.
   * Returns a disposable; the callback fires only when an `agentObservability.*`
   * key changes (the host's {@link SettingsReader} applies that filter).
   */
  onDidChange(listener: () => void): SettingsSubscription {
    return this.settings.onDidChange(listener);
  }
}
