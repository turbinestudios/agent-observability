import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Location of the durable Copilot telemetry ARCHIVE the extension owns.
 *
 * Unlike Copilot's native `agent-traces.db` (a short rolling window living in a
 * VS Code `globalStorage` dir — per-edition, per-environment), the archive is
 * anchored under the user's HOME so every VS Code window AND edition
 * (Stable / Insiders) on one OS user reads and writes ONE shared file. This is
 * what gives Copilot sessions the same "visible in every workspace" behavior
 * Claude Code already has (its CLI writes `~/.claude/projects`).
 *
 * Priority mirrors {@link ../claude/paths.resolveClaudeProjectsDirs}:
 * explicit override → `AGENT_OBSERVABILITY_HOME/copilot/...` → `~/.agent-observability/copilot/...`.
 * Pure path building over an injectable {@link ArchiveEnv} seam so it is
 * unit-testable on any platform; opens/creates nothing.
 */

/** Minimal config surface this module reads (satisfied by `Configuration`). */
export interface ArchivePathConfig {
  /** Explicit override of the archive DB file path, else `undefined`. */
  getCopilotArchivePathOverride(): string | undefined;
}

/** Host seam so resolution is unit-testable without the real process/os. */
export interface ArchiveEnv {
  homedir(): string;
  env: Record<string, string | undefined>;
}

const defaultEnv: ArchiveEnv = {
  homedir: () => os.homedir(),
  env: process.env,
};

/** Home-anchored directory name for the extension's own data. */
export const ARCHIVE_DIR_NAME = '.agent-observability';
/** Basename kept identical to Copilot's so the existing read layer is reused verbatim. */
export const ARCHIVE_DB_BASENAME = 'agent-traces.db';

/**
 * Resolve the durable archive DB path. Returns `undefined` only when no override
 * is set and no home directory can be determined (the archiver then stays inert).
 */
export function resolveArchiveDbPath(
  config: ArchivePathConfig,
  env: ArchiveEnv = defaultEnv,
): string | undefined {
  const override = config.getCopilotArchivePathOverride();
  if (override !== undefined && override.length > 0) {
    return path.normalize(override);
  }
  const base = env.env.AGENT_OBSERVABILITY_HOME;
  if (base !== undefined && base.length > 0) {
    return path.join(base, 'copilot', ARCHIVE_DB_BASENAME);
  }
  const home = env.homedir();
  if (home.length > 0) {
    return path.join(home, ARCHIVE_DIR_NAME, 'copilot', ARCHIVE_DB_BASENAME);
  }
  return undefined;
}
