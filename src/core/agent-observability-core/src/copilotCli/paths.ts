import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Where the GitHub Copilot CLI (and the Copilot SDK, which drives the same
 * runtime) keeps its sessions: `<COPILOT_HOME or ~/.copilot>/session-state/
 * <sessionId>/`, holding `workspace.yaml` and, once the session has actually
 * run, `events.jsonl`.
 *
 * Read-only by rule: nothing in this folder may write or delete under the
 * Copilot home. Probed against Copilot CLI 1.0.82–1.0.90 (October 2026); the
 * format is undocumented, so every reader here is tolerant.
 */

export interface CopilotCliDirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Host seam so discovery is unit-testable without the real home directory. */
export interface CopilotCliFs {
  homedir(): string;
  env: Record<string, string | undefined>;
  readDir(p: string): CopilotCliDirEntry[];
  stat(p: string): { size: number; mtimeMs: number } | undefined;
}

export const defaultCopilotCliFs: CopilotCliFs = {
  homedir: () => os.homedir(),
  env: process.env,
  readDir: (p) => {
    try {
      return fs
        .readdirSync(p, { withFileTypes: true })
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
    } catch {
      return [];
    }
  },
  stat: (p) => {
    try {
      const s = fs.statSync(p);
      return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : undefined;
    } catch {
      return undefined;
    }
  },
};

export function copilotHome(env: CopilotCliFs = defaultCopilotCliFs): string {
  const override = env.env.COPILOT_HOME;
  return override !== undefined && override.trim().length > 0
    ? path.normalize(override.trim())
    : path.join(env.homedir(), '.copilot');
}

export function copilotSessionStateDir(env: CopilotCliFs = defaultCopilotCliFs): string {
  return path.join(copilotHome(env), 'session-state');
}

/**
 * The dedicated working directory the app's own Copilot helper runs use, so
 * the sessions they leave behind can be recognised and left out of every
 * list and count without reading their content.
 */
export function copilotHelperCwd(env: Pick<CopilotCliFs, 'env' | 'homedir'> = defaultCopilotCliFs): string {
  const base = env.env.AGENT_OBSERVABILITY_HOME;
  const root =
    base !== undefined && base.trim().length > 0 ? base.trim() : path.join(env.homedir(), '.agent-observability');
  return path.join(root, 'helper-cwd');
}

export interface CopilotCliSessionFiles {
  sessionId: string;
  dir: string;
  eventsFile: string;
  workspaceFile: string;
  size: number;
  mtimeMs: number;
}

/**
 * Every session directory that has an `events.jsonl`, newest first. Most
 * directories are stubs the CLI creates and never fills; those are skipped.
 */
export function discoverCopilotCliSessions(env: CopilotCliFs = defaultCopilotCliFs): CopilotCliSessionFiles[] {
  const root = copilotSessionStateDir(env);
  const sessions: CopilotCliSessionFiles[] = [];
  for (const entry of env.readDir(root)) {
    if (!entry.isDirectory) {
      continue;
    }
    const dir = path.join(root, entry.name);
    const eventsFile = path.join(dir, 'events.jsonl');
    const stat = env.stat(eventsFile);
    if (stat === undefined || stat.size === 0) {
      continue;
    }
    sessions.push({
      sessionId: entry.name,
      dir,
      eventsFile,
      workspaceFile: path.join(dir, 'workspace.yaml'),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    });
  }
  return sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
