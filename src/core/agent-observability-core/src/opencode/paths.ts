import * as path from 'node:path';
import { defaultCopilotCliFs, type CopilotCliFs } from '../copilotCli/paths';

/**
 * Where OpenCode (opencode.ai) keeps its sessions: one SQLite database,
 *
 *   <XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db
 *
 * on every platform, Windows included (`%USERPROFILE%\.local\share\opencode`).
 * `OPENCODE_DB` moves it: an absolute path is used as is, a bare name sits in
 * the same data folder. Verified on opencode 2.1.2 (October 2026); builds
 * before the SQLite move kept JSON files under `storage/`, which is not read.
 *
 * Read-only by rule: nothing here writes or deletes under OpenCode's data
 * folder. The same folder holds `auth.json` and credential tables; neither is
 * ever opened.
 */

export const OPENCODE_DB_FILE = 'opencode.db';

export function opencodeDataDir(env: CopilotCliFs = defaultCopilotCliFs): string {
  const xdg = env.env.XDG_DATA_HOME;
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg.trim() : path.join(env.homedir(), '.local', 'share');
  return path.join(base, 'opencode');
}

/** The database file to read: the Settings override, else `OPENCODE_DB`, else the default. */
export function opencodeDbPath(override?: string, env: CopilotCliFs = defaultCopilotCliFs): string {
  if (override !== undefined && override.trim().length > 0) {
    return path.normalize(override.trim());
  }
  const fromEnv = env.env.OPENCODE_DB;
  if (fromEnv !== undefined && fromEnv.trim().length > 0) {
    const value = fromEnv.trim();
    return path.isAbsolute(value) ? path.normalize(value) : path.join(opencodeDataDir(env), value);
  }
  return path.join(opencodeDataDir(env), OPENCODE_DB_FILE);
}
