import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ConfigDefaults,
  ConfigKeys,
  Configuration,
  MIN_SESSION_MINUTES,
} from '@agent-observability/core/src/config/configuration';
import { defaultFs, resolveClaudeProjectsDirs, type ClaudeFs } from '@agent-observability/core/src/claude/paths';
import { candidateDatabasePaths } from '@agent-observability/core/src/telemetry/paths';
import {
  copilotJetbrainsRoot,
  discoverJetbrainsStores,
  jetbrainsIdeName,
  type JetbrainsStoreFile,
} from '@agent-observability/core/src/copilotJetbrains/paths';
import type { SettingsPatch, SettingsSnapshot } from '../shared/rpc';
import type { DesktopSettingsReader } from './drivers/desktopConfig';
import { resolveConfigPath } from './drivers/desktopConfig';
import { DEEP_RETRO_ENABLED_KEY } from './deepRetro';
import { IMPROVE_ENABLED_KEY } from './improve/contextPlan';
import { LIVE_NOTIFICATIONS_KEY } from './live/liveBoard';
import {
  TEAM_AUTO_EXPORT_KEY,
  TEAM_CONSENTED_AT_KEY,
  TEAM_ENABLED_KEY,
  TEAM_FOLDER_KEY,
  TEAM_REPOSITORIES_KEY,
  TEAM_REPOSITORY_MODE_KEY,
  TEAM_SHARE_ENABLED_KEY,
  teamEnabled,
  teamSharingOn,
} from './team/teamExport';
import { pickCopilotDatabases, type CopilotDatabaseCandidate } from './indexer/copilotIndexer';

/**
 * The settings surface behind the Settings view: what the four editable keys
 * hold, plus what auto-detection resolves them to right now. Reading and
 * writing goes through the same {@link DesktopSettingsReader} the rest of the
 * datahost uses, so a change here is immediately visible to the indexers.
 */

/** Settings key for hosting Copilot sessions (Run). OFF by default: a consent gate. */
export const RUN_ENABLED_KEY = 'run.enabled';
/** Settings key for the model a new hosted session starts with; empty = the CLI's default. */
export const RUN_DEFAULT_MODEL_KEY = 'run.defaultModel';
/** Set only by the `run.acknowledge` RPC, never through a settings patch. */
export const RUN_DISCLOSED_KEY = 'run.disclosed';

/** Settings key for the review packet's "Include what I asked" toggle (default on). */
export const PACKET_INCLUDE_PROMPTS_KEY = 'packet.includePrompts';

/** Injectable environment so tests never scan the developer's real machine. */
export interface SettingsSeams {
  claudeFs?: ClaudeFs;
  pickCopilots?: (config: Configuration) => CopilotDatabaseCandidate[];
  copilotCandidates?: (config: Configuration) => string[];
  exists?: (p: string) => boolean;
  configPath?: string;
  /** This install's anonymous team id; absent in tests so no salt file is minted. */
  teamDeveloperId?: () => string;
  now?: () => number;
  /** The Copilot JetBrains chat stores; absent in tests so the real root is never listed. */
  jetbrainsStores?: () => JetbrainsStoreFile[];
}

/** The current settings plus their resolved effect, for `settings.get`. */
export function buildSettingsSnapshot(
  settings: DesktopSettingsReader,
  config: Configuration,
  seams: SettingsSeams = {},
): SettingsSnapshot {
  const exists = seams.exists ?? fs.existsSync;
  const pick = seams.pickCopilots ?? pickCopilotDatabases;
  const candidates = seams.copilotCandidates ?? candidateDatabasePaths;
  const claudeProjectsPath = storedString(settings, ConfigKeys.claudeProjectsPath);
  const sqlitePath = storedString(settings, ConfigKeys.sqlitePath);
  const configPath = seams.configPath ?? resolveConfigPath();
  const teamFolder = storedString(settings, TEAM_FOLDER_KEY);
  const storedMode = storedString(settings, TEAM_REPOSITORY_MODE_KEY);
  const teamMode: SettingsSnapshot['teamRepositoryMode'] =
    storedMode === 'include' || storedMode === 'exclude' ? storedMode : 'all';

  return {
    claudeEnabled: config.isClaudeEnabled(),
    claudeProjectsPath,
    copilotEnabled: config.isLocalTelemetryEnabled(),
    sqlitePath,
    copilotCliEnabled: config.isCopilotCliEnabled(),
    copilotAppEnabled: config.isCopilotAppEnabled(),
    copilotJetbrainsEnabled: config.isCopilotJetbrainsEnabled(),
    copilotJetbrainsStorePath: storedString(settings, ConfigKeys.copilotJetbrainsStorePath),
    // Where the JetBrains reader looks and what it found there, so a miss on a
    // machine with Rider installed is visible rather than an empty list.
    copilotJetbrainsRoot: copilotJetbrainsRoot(config.getCopilotJetbrainsStorePath()),
    resolvedJetbrainsStores: (seams.jetbrainsStores ?? (() => discoverJetbrainsStores(config.getCopilotJetbrainsStorePath())))().map(
      (store) => ({ path: store.path, ide: jetbrainsIdeName(store.ide) }),
    ),
    resolvedClaudeDirs: resolveClaudeProjectsDirs(config, seams.claudeFs ?? defaultFs),
    claudeOverrideMissing: claudeProjectsPath !== '' && !exists(claudeProjectsPath),
    resolvedCopilotDbs: pick(config).map((db) => ({
      path: db.path,
      kind: db.archive ? ('archive' as const) : db.override ? ('override' as const) : ('native' as const),
    })),
    // Where auto-detect looks, so the page can explain a "nothing found"
    // instead of leaving a first-time user guessing.
    copilotScannedPaths: candidates(config),
    sqliteOverrideMissing: sqlitePath !== '' && !exists(sqlitePath),
    // Read through Configuration rather than the raw store, so the page shows
    // the clamped value the detector will actually use.
    maxSessionMinutes: config.getMaxSessionMinutes(),
    deepRetroEnabled: storedBoolean(settings, DEEP_RETRO_ENABLED_KEY, false),
    improveEnabled: storedBoolean(settings, IMPROVE_ENABLED_KEY, false),
    claudeCliPath: storedString(settings, ConfigKeys.aiHelperClaudeCliPath),
    // Effective values (defaulted/clamped), same reasoning as maxSessionMinutes.
    claudeModel: config.getAiHelperClaudeModel(),
    claudeEffort: config.getAiHelperClaudeEffort(),
    // Effective on THIS machine: the stored default `copilot` is the VS Code
    // `vscode.lm` backend the desktop cannot carry, and the registry resolves
    // it to Claude Code — the page must show where sends actually go.
    aiBackend: config.getAiHelperBackend() === 'copilot-cli' ? 'copilot-cli' : 'claude-code',
    copilotCliPath: storedString(settings, ConfigKeys.aiHelperCopilotCliPath),
    liveNotifications: storedBoolean(settings, LIVE_NOTIFICATIONS_KEY, false),
    runEnabled: storedBoolean(settings, RUN_ENABLED_KEY, false),
    runDefaultModel: storedString(settings, RUN_DEFAULT_MODEL_KEY),
    packetIncludePrompts: storedBoolean(settings, PACKET_INCLUDE_PROMPTS_KEY, true),
    teamEnabled: teamEnabled(settings),
    teamFolder,
    teamFolderExists: teamFolder !== '' && exists(teamFolder),
    // Sharing reads as ON only when the toggle is on AND consent was recorded —
    // the same pair the datahost's export gate checks.
    teamShareEnabled: teamSharingOn(settings),
    teamAutoExport: storedBoolean(settings, TEAM_AUTO_EXPORT_KEY, true),
    teamRepositoryMode: teamMode,
    teamRepositories: storedStringList(settings, TEAM_REPOSITORIES_KEY),
    // Asking for the id creates this install's salt file, so it is not asked
    // for while Team is off.
    teamDeveloperId: teamEnabled(settings) ? (seams.teamDeveloperId?.() ?? '') : '',
    configPath,
    configDir: path.dirname(configPath),
  };
}

/**
 * Persist a settings patch and report which source domains actually changed, so
 * the caller knows what to refresh. Paths are trimmed; an emptied path deletes
 * its key (falling back to auto-detect) rather than storing ''. Values of the
 * wrong runtime type are ignored — RPC payloads are untyped on the wire.
 */
export function applySettingsPatch(
  settings: DesktopSettingsReader,
  patch: SettingsPatch,
  seams: Pick<SettingsSeams, 'now'> = {},
): { claude: boolean; copilot: boolean; deviation: boolean; deepRetro: boolean; ai: boolean; team: boolean } {
  const update: Record<string, unknown> = {};
  const changed = { claude: false, copilot: false, deviation: false, deepRetro: false, ai: false, team: false };

  if (typeof patch.claudeEnabled === 'boolean' && patch.claudeEnabled !== storedBoolean(settings, ConfigKeys.claudeEnabled, ConfigDefaults.claudeEnabled)) {
    update[ConfigKeys.claudeEnabled] = patch.claudeEnabled;
    changed.claude = true;
  }
  if (typeof patch.claudeProjectsPath === 'string') {
    const next = patch.claudeProjectsPath.trim();
    if (next !== storedString(settings, ConfigKeys.claudeProjectsPath)) {
      update[ConfigKeys.claudeProjectsPath] = next.length > 0 ? next : undefined;
      changed.claude = true;
    }
  }
  if (typeof patch.copilotEnabled === 'boolean' && patch.copilotEnabled !== storedBoolean(settings, ConfigKeys.localTelemetryEnabled, ConfigDefaults.localTelemetryEnabled)) {
    update[ConfigKeys.localTelemetryEnabled] = patch.copilotEnabled;
    changed.copilot = true;
  }
  // Copilot CLI sessions are a third local source; it rides the `copilot`
  // flag because the same refresh (sources, detail cache, live board) applies.
  if (typeof patch.copilotCliEnabled === 'boolean' && patch.copilotCliEnabled !== storedBoolean(settings, ConfigKeys.copilotCliEnabled, ConfigDefaults.copilotCliEnabled)) {
    update[ConfigKeys.copilotCliEnabled] = patch.copilotCliEnabled;
    changed.copilot = true;
  }
  if (typeof patch.copilotAppEnabled === 'boolean' && patch.copilotAppEnabled !== storedBoolean(settings, ConfigKeys.copilotAppEnabled, ConfigDefaults.copilotAppEnabled)) {
    update[ConfigKeys.copilotAppEnabled] = patch.copilotAppEnabled;
    changed.copilot = true;
  }
  if (typeof patch.copilotJetbrainsEnabled === 'boolean' && patch.copilotJetbrainsEnabled !== storedBoolean(settings, ConfigKeys.copilotJetbrainsEnabled, ConfigDefaults.copilotJetbrainsEnabled)) {
    update[ConfigKeys.copilotJetbrainsEnabled] = patch.copilotJetbrainsEnabled;
    changed.copilot = true;
  }
  if (typeof patch.copilotJetbrainsStorePath === 'string') {
    const next = patch.copilotJetbrainsStorePath.trim();
    if (next !== storedString(settings, ConfigKeys.copilotJetbrainsStorePath)) {
      update[ConfigKeys.copilotJetbrainsStorePath] = next.length > 0 ? next : undefined;
      changed.copilot = true;
    }
  }
  if (typeof patch.sqlitePath === 'string') {
    const next = patch.sqlitePath.trim();
    if (next !== storedString(settings, ConfigKeys.sqlitePath)) {
      update[ConfigKeys.sqlitePath] = next.length > 0 ? next : undefined;
      changed.copilot = true;
    }
  }

  // The duration threshold decides what counts as an overlong turn, so every
  // stored deviation verdict is recomputed against the new value.
  if (typeof patch.maxSessionMinutes === 'number' && Number.isFinite(patch.maxSessionMinutes)) {
    const next = Math.max(MIN_SESSION_MINUTES, Math.floor(patch.maxSessionMinutes));
    if (next !== effectiveConfig(settings).getMaxSessionMinutes()) {
      update[ConfigKeys.maxSessionMinutes] = next;
      changed.deviation = true;
    }
  }

  // The deep-retrospective gate: a consent surface, so it is stored only on a
  // real boolean and never inferred.
  if (
    typeof patch.deepRetroEnabled === 'boolean' &&
    patch.deepRetroEnabled !== storedBoolean(settings, DEEP_RETRO_ENABLED_KEY, false)
  ) {
    update[DEEP_RETRO_ENABLED_KEY] = patch.deepRetroEnabled;
    changed.deepRetro = true;
  }

  // The improvement-plan gate: the same consent-surface rule as the deep
  // retrospective's — stored only on a real boolean, never inferred. Rides the
  // `deepRetro` changed flag; neither needs anything rebuilt.
  if (
    typeof patch.improveEnabled === 'boolean' &&
    patch.improveEnabled !== storedBoolean(settings, IMPROVE_ENABLED_KEY, false)
  ) {
    update[IMPROVE_ENABLED_KEY] = patch.improveEnabled;
    changed.deepRetro = true;
  }

  // The AI keys. `changed.ai` makes the caller rebuild the backend registry:
  // a successful CLI probe is cached per backend instance, so a changed path
  // would otherwise be ignored until the app restarts.
  if (typeof patch.claudeCliPath === 'string') {
    const next = patch.claudeCliPath.trim();
    if (next !== storedString(settings, ConfigKeys.aiHelperClaudeCliPath)) {
      update[ConfigKeys.aiHelperClaudeCliPath] = next.length > 0 ? next : undefined;
      changed.ai = true;
    }
  }
  if (typeof patch.claudeModel === 'string') {
    const next = patch.claudeModel.trim();
    if (next !== storedString(settings, ConfigKeys.aiHelperClaudeModel)) {
      update[ConfigKeys.aiHelperClaudeModel] = next.length > 0 ? next : undefined;
      changed.ai = true;
    }
  }
  if (typeof patch.claudeEffort === 'string') {
    const next = patch.claudeEffort.trim();
    if (next !== storedString(settings, ConfigKeys.aiHelperClaudeEffort)) {
      update[ConfigKeys.aiHelperClaudeEffort] = next.length > 0 ? next : undefined;
      changed.ai = true;
    }
  }
  // The backend picker: only the two ids the desktop can actually run are
  // accepted — anything else on the wire is ignored, not stored.
  if (patch.aiBackend === 'claude-code' || patch.aiBackend === 'copilot-cli') {
    if (patch.aiBackend !== storedString(settings, ConfigKeys.aiHelperBackend)) {
      update[ConfigKeys.aiHelperBackend] = patch.aiBackend;
      changed.ai = true;
    }
  }
  if (typeof patch.copilotCliPath === 'string') {
    const next = patch.copilotCliPath.trim();
    if (next !== storedString(settings, ConfigKeys.aiHelperCopilotCliPath)) {
      update[ConfigKeys.aiHelperCopilotCliPath] = next.length > 0 ? next : undefined;
      changed.ai = true;
    }
  }

  // The Run gate: a consent surface, stored only on a real boolean. Rides the
  // `deepRetro` flag because nothing needs rebuilding. `run.disclosed` is NOT
  // settable from here: only the notice's acknowledge call records it.
  if (typeof patch.runEnabled === 'boolean' && patch.runEnabled !== storedBoolean(settings, RUN_ENABLED_KEY, false)) {
    update[RUN_ENABLED_KEY] = patch.runEnabled;
    changed.deepRetro = true;
  }
  if (typeof patch.runDefaultModel === 'string') {
    const next = patch.runDefaultModel.trim();
    if (next !== storedString(settings, RUN_DEFAULT_MODEL_KEY) && /^[A-Za-z0-9._:-]*$/.test(next)) {
      update[RUN_DEFAULT_MODEL_KEY] = next.length > 0 ? next : undefined;
      changed.deepRetro = true;
    }
  }

  // Whether a review packet quotes the user's own request lines: a plain
  // preference remembered between dialogs, stored only on a real boolean.
  if (
    typeof patch.packetIncludePrompts === 'boolean' &&
    patch.packetIncludePrompts !== storedBoolean(settings, PACKET_INCLUDE_PROMPTS_KEY, true)
  ) {
    update[PACKET_INCLUDE_PROMPTS_KEY] = patch.packetIncludePrompts;
    changed.deepRetro = true;
  }

  // The live-board notification toggle: a plain preference, stored only on a
  // real boolean like the consent gates (RPC payloads are untyped on the wire).
  // Rides the `deepRetro` flag because nothing needs rebuilding either.
  if (
    typeof patch.liveNotifications === 'boolean' &&
    patch.liveNotifications !== storedBoolean(settings, LIVE_NOTIFICATIONS_KEY, false)
  ) {
    update[LIVE_NOTIFICATIONS_KEY] = patch.liveNotifications;
    changed.deepRetro = true;
  }

  // The team keys. The folder is a plain path; sharing is a consent surface
  // and records WHEN it was granted, which the export gate requires alongside
  // the boolean — a hand-edited `true` in config.json alone does not share.
  //
  // `team.enabled` is the switch for the whole feature. Turning it off also
  // withdraws sharing, so turning Team on again never resumes writing to the
  // folder by itself; and sharing cannot be turned on while Team is off.
  const teamWasOn = storedBoolean(settings, TEAM_ENABLED_KEY, false);
  const teamOn = typeof patch.teamEnabled === 'boolean' ? patch.teamEnabled : teamWasOn;
  if (teamOn !== teamWasOn) {
    update[TEAM_ENABLED_KEY] = teamOn;
    if (!teamOn) {
      update[TEAM_SHARE_ENABLED_KEY] = false;
      update[TEAM_CONSENTED_AT_KEY] = undefined;
    }
    changed.team = true;
  }
  if (typeof patch.teamFolder === 'string') {
    const next = patch.teamFolder.trim();
    if (next !== storedString(settings, TEAM_FOLDER_KEY)) {
      update[TEAM_FOLDER_KEY] = next.length > 0 ? next : undefined;
      changed.team = true;
    }
  }
  if (
    typeof patch.teamShareEnabled === 'boolean' &&
    teamOn &&
    patch.teamShareEnabled !== storedBoolean(settings, TEAM_SHARE_ENABLED_KEY, false)
  ) {
    update[TEAM_SHARE_ENABLED_KEY] = patch.teamShareEnabled;
    update[TEAM_CONSENTED_AT_KEY] = patch.teamShareEnabled ? (seams.now?.() ?? Date.now()) : undefined;
    changed.team = true;
  }
  if (
    typeof patch.teamAutoExport === 'boolean' &&
    patch.teamAutoExport !== storedBoolean(settings, TEAM_AUTO_EXPORT_KEY, true)
  ) {
    update[TEAM_AUTO_EXPORT_KEY] = patch.teamAutoExport;
    changed.team = true;
  }
  if (
    patch.teamRepositoryMode === 'all' ||
    patch.teamRepositoryMode === 'include' ||
    patch.teamRepositoryMode === 'exclude'
  ) {
    if (patch.teamRepositoryMode !== storedString(settings, TEAM_REPOSITORY_MODE_KEY)) {
      update[TEAM_REPOSITORY_MODE_KEY] = patch.teamRepositoryMode;
      changed.team = true;
    }
  }
  if (Array.isArray(patch.teamRepositories)) {
    const next = patch.teamRepositories
      .filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
      .map((r) => r.trim());
    const current = storedStringList(settings, TEAM_REPOSITORIES_KEY);
    if (next.length !== current.length || next.some((r, i) => r !== current[i])) {
      update[TEAM_REPOSITORIES_KEY] = next;
      changed.team = true;
    }
  }

  if (changed.claude || changed.copilot || changed.deviation || changed.deepRetro || changed.ai || changed.team) {
    settings.update(update);
  }
  return changed;
}

/**
 * The effective configuration over a settings store — used to compare a patch
 * against the CLAMPED current value rather than the raw one, so re-sending the
 * same number is not mistaken for a change.
 */
function effectiveConfig(settings: DesktopSettingsReader): Configuration {
  return new Configuration(settings);
}

/** The stored string for a key, trimmed; non-strings read as unset. */
function storedString(settings: DesktopSettingsReader, key: string): string {
  const value = settings.get<unknown>(key, '');
  return typeof value === 'string' ? value.trim() : '';
}

/** The stored string list for a key; anything else reads as empty. */
function storedStringList(settings: DesktopSettingsReader, key: string): string[] {
  const value = settings.get<unknown>(key, []);
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/** The stored boolean for a key; non-booleans read as the default. */
function storedBoolean(settings: DesktopSettingsReader, key: string, fallback: boolean): boolean {
  const value = settings.get<unknown>(key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}
