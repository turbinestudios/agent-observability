import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Discovery of Claude Code transcripts under `~/.claude/projects/`.
 *
 * Layout (validated against real data — see the `claude-code-ingestion-decision`
 * memory):
 *
 * ```
 * <config>/projects/<encoded-cwd>/<sessionId>.jsonl                      ← main transcript
 * <config>/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl ← sub-agent side-chains
 * ```
 *
 * `<config>` defaults to `~/.claude`, honoring the `CLAUDE_CONFIG_DIR` env var
 * and an explicit `agentObservability.claudeCode.projectsPath` override. We never
 * decode the `<encoded-cwd>` directory name (it is lossy); the real `cwd` is read
 * from inside the records by the mapper.
 *
 * Discovery is a bounded recursive scan for `*.jsonl` (depth-capped like Argus's
 * `scanDepth`) that classifies each file as a main transcript or a sub-agent
 * side-chain and groups them by session id. Pure I/O over a {@link ClaudeFs} seam
 * so it is unit-testable without touching the real filesystem.
 */

/** A directory entry as returned by {@link ClaudeFs.readDir}. */
export interface DirEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

/** Host seam so discovery is unit-testable on any platform. */
export interface ClaudeFs {
  homedir(): string;
  env: Record<string, string | undefined>;
  /** Whether a path exists and is a directory. */
  isDirectory(p: string): boolean;
  /** Directory listing; returns `[]` on any error (missing / permission). */
  readDir(p: string): DirEntry[];
  /** File mtime in epoch ms, or `undefined` when unavailable. */
  mtimeMs(p: string): number | undefined;
}

/** Minimal config surface this module reads (satisfied by `Configuration`). */
export interface ClaudePathConfig {
  /** Explicit override of the projects directory, else `undefined`. */
  getClaudeProjectsPathOverride(): string | undefined;
  /** Max directory depth to recurse when scanning for transcripts. */
  getClaudeScanDepth(): number;
}

/** One discovered session: its main transcript plus any sub-agent side-chains. */
export interface ClaudeSessionFiles {
  /** Session id (the main transcript's basename, or the dir above `subagents/`). */
  sessionId: string;
  /** Absolute path to `<sessionId>.jsonl`, when a main transcript exists. */
  mainFile?: string;
  /** Absolute paths to `subagents/agent-*.jsonl` side-chains. */
  subagentFiles: string[];
  /** Newest mtime (epoch ms) across the session's files — for caching + sort. */
  mtimeMs: number;
}

const defaultFs: ClaudeFs = {
  homedir: () => os.homedir(),
  env: process.env,
  isDirectory: (p) => {
    try {
      return fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
  readDir: (p) => {
    try {
      return fs.readdirSync(p, { withFileTypes: true }).map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isFile: d.isFile(),
      }));
    } catch {
      return [];
    }
  },
  mtimeMs: (p) => {
    try {
      return fs.statSync(p).mtimeMs;
    } catch {
      return undefined;
    }
  },
};

/**
 * Resolve the candidate `projects` directories that exist on disk, in priority
 * order: explicit override → `CLAUDE_CONFIG_DIR/projects` → `~/.claude/projects`.
 * Deduplicated; only directories that actually exist are returned.
 */
export function resolveClaudeProjectsDirs(
  config: ClaudePathConfig,
  env: ClaudeFs = defaultFs,
): string[] {
  const candidates: string[] = [];
  const override = config.getClaudeProjectsPathOverride();
  if (override !== undefined && override.length > 0) {
    candidates.push(override);
  }
  const configDir = env.env.CLAUDE_CONFIG_DIR;
  if (configDir !== undefined && configDir.length > 0) {
    candidates.push(path.join(configDir, 'projects'));
  }
  const home = env.homedir();
  if (home.length > 0) {
    candidates.push(path.join(home, '.claude', 'projects'));
  }

  const seen = new Set<string>();
  const dirs: string[] = [];
  for (const candidate of candidates) {
    const normalized = path.normalize(candidate);
    if (!seen.has(normalized) && env.isDirectory(normalized)) {
      seen.add(normalized);
      dirs.push(normalized);
    }
  }
  return dirs;
}

/**
 * Discover every session under the resolved projects directories, grouping main
 * transcripts with their sub-agent side-chains. Sessions are returned newest
 * (largest mtime) first. A session that only has sub-agent files (its main
 * transcript vanished) is still returned so its activity is not lost.
 */
export function discoverClaudeSessions(
  config: ClaudePathConfig,
  env: ClaudeFs = defaultFs,
): ClaudeSessionFiles[] {
  const roots = resolveClaudeProjectsDirs(config, env);
  const maxDepth = clampDepth(config.getClaudeScanDepth());

  // sessionId → accumulator. Sub-agent files can be discovered before the main.
  const sessions = new Map<string, ClaudeSessionFiles>();

  const ensure = (sessionId: string): ClaudeSessionFiles => {
    let entry = sessions.get(sessionId);
    if (entry === undefined) {
      entry = { sessionId, subagentFiles: [], mtimeMs: 0 };
      sessions.set(sessionId, entry);
    }
    return entry;
  };

  for (const root of roots) {
    walk(root, 0, maxDepth, false, env, (filePath) => {
      const classified = classifyTranscriptFile(root, filePath);
      if (classified === undefined) {
        return;
      }
      const entry = ensure(classified.sessionId);
      const mtime = env.mtimeMs(filePath) ?? 0;
      if (mtime > entry.mtimeMs) {
        entry.mtimeMs = mtime;
      }
      if (classified.kind === 'main') {
        // Prefer the first main file seen for a given id (roots are priority-ordered).
        if (entry.mainFile === undefined) {
          entry.mainFile = filePath;
        }
      } else {
        entry.subagentFiles.push(filePath);
      }
    });
  }

  return [...sessions.values()].sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Classify a discovered `.jsonl` path relative to its scan root. */
export function classifyTranscriptFile(
  root: string,
  filePath: string,
): { sessionId: string; kind: 'main' | 'subagent' } | undefined {
  if (!filePath.toLowerCase().endsWith('.jsonl')) {
    return undefined;
  }
  const rel = path.relative(root, filePath);
  const segments = rel.split(/[\\/]/).filter((s) => s.length > 0);
  if (segments.length === 0) {
    return undefined;
  }
  const subIdx = segments.indexOf('subagents');
  if (subIdx >= 1) {
    // `<...>/<sessionId>/subagents/agent-<id>.jsonl`
    const sessionId = segments[subIdx - 1];
    if (sessionId.length > 0) {
      return { sessionId, kind: 'subagent' };
    }
    return undefined;
  }
  const base = segments[segments.length - 1];
  const sessionId = base.slice(0, -'.jsonl'.length);
  if (sessionId.length === 0) {
    return undefined;
  }
  return { sessionId, kind: 'main' };
}

/**
 * Bounded DFS that invokes `onFile` for every `.jsonl` file found. The scan-depth
 * budget applies to the project tree, but once inside a `subagents/` directory the
 * budget is BYPASSED (`inSubagents`) so a session's sub-agent side-chains are never
 * starved no matter how deeply Claude nests them (e.g. `subagents/workflows/wf_<id>/`).
 */
function walk(
  dir: string,
  depth: number,
  maxDepth: number,
  inSubagents: boolean,
  env: ClaudeFs,
  onFile: (filePath: string) => void,
): void {
  const entries = env.readDir(dir);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile) {
      if (entry.name.toLowerCase().endsWith('.jsonl')) {
        onFile(full);
      }
    } else if (entry.isDirectory && (inSubagents || depth < maxDepth)) {
      const childInSubagents = inSubagents || entry.name === 'subagents';
      walk(full, depth + 1, maxDepth, childInSubagents, env, onFile);
    }
  }
}

/** Clamp the configured scan depth to a sane range. */
function clampDepth(raw: number): number {
  if (!Number.isFinite(raw)) {
    return 8;
  }
  return Math.min(12, Math.max(1, Math.floor(raw)));
}
