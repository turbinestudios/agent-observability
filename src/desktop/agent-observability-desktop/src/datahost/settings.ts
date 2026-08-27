import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Configuration } from '@agent-observability/core/src/config/configuration';
import { ConfigDefaults, ConfigKeys } from '@agent-observability/core/src/config/configuration';
import { defaultFs, resolveClaudeProjectsDirs, type ClaudeFs } from '@agent-observability/core/src/claude/paths';
import type { SettingsPatch, SettingsSnapshot } from '../shared/rpc';
import type { DesktopSettingsReader } from './drivers/desktopConfig';
import { resolveConfigPath } from './drivers/desktopConfig';
import { pickCopilotDatabase, type CopilotDatabaseCandidate } from './indexer/copilotIndexer';

/**
 * The settings surface behind the Settings view: what the four editable keys
 * hold, plus what auto-detection resolves them to right now. Reading and
 * writing goes through the same {@link DesktopSettingsReader} the rest of the
 * datahost uses, so a change here is immediately visible to the indexers.
 */

/** Injectable environment so tests never scan the developer's real machine. */
export interface SettingsSeams {
  claudeFs?: ClaudeFs;
  pickCopilot?: (config: Configuration) => CopilotDatabaseCandidate | undefined;
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
  const pick = seams.pickCopilot ?? pickCopilotDatabase;
  const claudeProjectsPath = storedString(settings, ConfigKeys.claudeProjectsPath);
  const sqlitePath = storedString(settings, ConfigKeys.sqlitePath);
  const copilotDb = pick(config);
  const configPath = seams.configPath ?? resolveConfigPath();

  return {
    claudeEnabled: config.isClaudeEnabled(),
    claudeProjectsPath,
    copilotEnabled: config.isLocalTelemetryEnabled(),
    sqlitePath,
    resolvedClaudeDirs: resolveClaudeProjectsDirs(config, seams.claudeFs ?? defaultFs),
    claudeOverrideMissing: claudeProjectsPath !== '' && !exists(claudeProjectsPath),
    ...(copilotDb !== undefined
      ? {
          resolvedCopilotDb: {
            path: copilotDb.path,
            kind: copilotDb.archive ? ('archive' as const) : copilotDb.override ? ('override' as const) : ('native' as const),
          },
        }
      : {}),
    sqliteOverrideMissing: sqlitePath !== '' && !exists(sqlitePath),
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
): { claude: boolean; copilot: boolean } {
  const update: Record<string, unknown> = {};
  const changed = { claude: false, copilot: false };

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

  if (changed.claude || changed.copilot) {
    settings.update(update);
  }
  return changed;
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
