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
import type { SettingsPatch, SettingsSnapshot } from '../shared/rpc';
import type { DesktopSettingsReader } from './drivers/desktopConfig';
import { resolveConfigPath } from './drivers/desktopConfig';
import { DEEP_RETRO_ENABLED_KEY } from './deepRetro';
import { IMPROVE_ENABLED_KEY } from './improve/contextPlan';
import { pickCopilotDatabases, type CopilotDatabaseCandidate } from './indexer/copilotIndexer';

/**
 * The settings surface behind the Settings view: what the four editable keys
 * hold, plus what auto-detection resolves them to right now. Reading and
 * writing goes through the same {@link DesktopSettingsReader} the rest of the
 * datahost uses, so a change here is immediately visible to the indexers.
 */

/** Injectable environment so tests never scan the developer's real machine. */
export interface SettingsSeams {
  claudeFs?: ClaudeFs;
  pickCopilots?: (config: Configuration) => CopilotDatabaseCandidate[];
  copilotCandidates?: (config: Configuration) => string[];
  exists?: (p: string) => boolean;
  configPath?: string;
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

  return {
    claudeEnabled: config.isClaudeEnabled(),
    claudeProjectsPath,
    copilotEnabled: config.isLocalTelemetryEnabled(),
    sqlitePath,
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
): { claude: boolean; copilot: boolean; deviation: boolean; deepRetro: boolean; ai: boolean } {
  const update: Record<string, unknown> = {};
  const changed = { claude: false, copilot: false, deviation: false, deepRetro: false, ai: false };

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

  if (changed.claude || changed.copilot || changed.deviation || changed.deepRetro || changed.ai) {
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

/** The stored boolean for a key; non-booleans read as the default. */
function storedBoolean(settings: DesktopSettingsReader, key: string, fallback: boolean): boolean {
  const value = settings.get<unknown>(key, fallback);
  return typeof value === 'boolean' ? value : fallback;
}
