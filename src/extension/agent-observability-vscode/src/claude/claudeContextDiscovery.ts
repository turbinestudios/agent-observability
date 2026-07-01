/**
 * Filesystem + transcript discovery of the context files a Claude Code session
 * pulled into its window. This is the Claude analogue of Copilot's discovery
 * spans: Claude Code emits no "here is what I loaded" telemetry, so we reconstruct
 * it from two signals —
 *
 *  1. Always-in-context memory — the `CLAUDE.md` / `CLAUDE.local.md` hierarchy
 *     walked up from the session's `cwd`, plus the user's `~/.claude/CLAUDE.md`.
 *     Claude Code injects these automatically every turn.
 *  2. On-invocation loads — `Read` tool calls that target context directories, and
 *     `Skill` invocations (each loads a `SKILL.md`). Agent definitions are resolved
 *     for spawned sub-agents by the analyzer.
 *
 * Caveat (documented for the UI): the filesystem is read at analysis time, so this
 * reflects the CURRENT state on disk, not the exact bytes present when the session
 * ran. Copilot's equivalent is point-in-time telemetry. A memory file edited or
 * deleted since the run will differ.
 *
 * Pure I/O over the {@link ClaudeFs} seam (existence/listing) — the downstream
 * size/reference passes read file CONTENT directly via `node:fs` off `filePath`.
 *
 * LOCAL-ONLY: paths and content are read on-machine for the local view only; never
 * logged or placed on the cloud-aggregate path.
 */

import * as path from 'node:path';
import type { ContextFileEntry } from '../context/models';
import type { ToolReadRow } from '../context/toolCallDetector';
import { contentBlocks, type TranscriptRecord } from './transcript';
import type { ClaudeFs } from './paths';

/** Path fragments (forward-slash normalized) that mark a context file. */
const CONTEXT_PATH_FRAGMENTS: readonly string[] = [
  '.claude/',
  '.github/',
  '.agents/',
  '.copilot/',
];

/** Basenames (lowercased) that are context files wherever they live. */
const CONTEXT_BASENAMES: ReadonlySet<string> = new Set([
  'claude.md',
  'claude.local.md',
  'agents.md',
  'copilot-instructions.md',
]);

/** Whether a file path points at a known context file. */
export function isContextPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const base = normalized.split('/').pop()?.toLowerCase() ?? '';
  if (CONTEXT_BASENAMES.has(base)) {
    return true;
  }
  if (base.endsWith('.instructions.md') || base.endsWith('.prompt.md') || base.endsWith('.agent.md')) {
    return true;
  }
  return CONTEXT_PATH_FRAGMENTS.some((frag) => normalized.includes(frag));
}

/**
 * The always-in-context memory files for a session: every `CLAUDE.md` /
 * `CLAUDE.local.md` from `cwd` up to the filesystem root, plus the user-level
 * `~/.claude/CLAUDE.md`. Only files that currently exist on disk are returned.
 * Names are uniquified (qualified by their directory) when the same basename
 * appears at multiple levels.
 */
export function discoverMemoryFiles(cwd: string | undefined, env: ClaudeFs): ContextFileEntry[] {
  const entries: ContextFileEntry[] = [];
  const seen = new Set<string>();

  const push = (filePath: string): void => {
    const norm = path.normalize(filePath);
    if (seen.has(norm) || !fileExists(env, norm)) {
      return;
    }
    seen.add(norm);
    entries.push({
      name: path.basename(norm),
      filePath: norm,
      category: 'instruction',
      status: 'applied',
    });
  };

  if (cwd !== undefined && cwd.length > 0) {
    let dir = path.normalize(cwd);
    for (let guard = 0; guard < 64; guard++) {
      push(path.join(dir, 'CLAUDE.md'));
      push(path.join(dir, 'CLAUDE.local.md'));
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }

  const home = env.homedir();
  if (home.length > 0) {
    push(path.join(home, '.claude', 'CLAUDE.md'));
  }

  return uniquifyNames(entries);
}

/**
 * Context-file `Read` tool calls across a transcript's records, as raw tool-read
 * rows for {@link ../context/toolCallDetector.parseToolReads}. Claude's `Read`
 * tool carries the path on `input.file_path`; only context-directory targets are
 * kept.
 */
export function detectContextToolReads(records: readonly TranscriptRecord[]): ToolReadRow[] {
  const rows: ToolReadRow[] = [];
  for (const record of records) {
    for (const block of contentBlocks(record.message)) {
      if (block.type !== 'tool_use' || block.name !== 'Read') {
        continue;
      }
      const filePath = stringField(block.input, 'file_path');
      if (filePath !== undefined && isContextPath(filePath)) {
        rows.push({ filePath, conversationId: null, chatSessionId: null });
      }
    }
  }
  return rows;
}

/**
 * Skills invoked via the `Skill` tool in a transcript's records, as `applied`
 * context files. Each invocation loads that skill's `SKILL.md`; the file path is
 * resolved best-effort against the project and user `.claude/skills/<name>/`.
 * Plugin-namespaced skills (`plugin:skill`) that don't resolve on disk are still
 * recorded by name (no size estimate).
 */
export function detectInvokedSkills(
  records: readonly TranscriptRecord[],
  cwd: string | undefined,
  env: ClaudeFs,
): ContextFileEntry[] {
  const entries: ContextFileEntry[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const block of contentBlocks(record.message)) {
      if (block.type !== 'tool_use' || block.name !== 'Skill') {
        continue;
      }
      const skill = stringField(block.input, 'skill');
      if (skill === undefined || seen.has(skill)) {
        continue;
      }
      seen.add(skill);
      const filePath = resolveInDotClaude(`skills/${bareSkillName(skill)}/SKILL.md`, cwd, env);
      entries.push({
        name: skill,
        category: 'skill',
        status: 'applied',
        ...(filePath !== undefined ? { filePath } : {}),
      });
    }
  }
  return entries;
}

/**
 * The on-disk agent-definition file for a sub-agent type (`.claude/agents/<type>.md`),
 * as an `applied` context file, or `undefined` for built-in agents that have no
 * definition file (e.g. `Explore`, `Plan`, `general-purpose`).
 */
export function resolveAgentDefinition(
  agentType: string | undefined,
  cwd: string | undefined,
  env: ClaudeFs,
): ContextFileEntry | undefined {
  if (agentType === undefined || agentType.length === 0) {
    return undefined;
  }
  const filePath = resolveInDotClaude(`agents/${agentType}.md`, cwd, env);
  if (filePath === undefined) {
    return undefined;
  }
  return {
    name: `${agentType}.md`,
    filePath,
    category: 'agent',
    status: 'applied',
  };
}

// ── internals ────────────────────────────────────────────────────────────────

/**
 * Resolve `<rel>` under the nearest project `.claude/` (walking up from `cwd`) or,
 * failing that, the user `~/.claude/`. Returns the first existing match.
 */
function resolveInDotClaude(rel: string, cwd: string | undefined, env: ClaudeFs): string | undefined {
  if (cwd !== undefined && cwd.length > 0) {
    let dir = path.normalize(cwd);
    for (let guard = 0; guard < 64; guard++) {
      const candidate = path.join(dir, '.claude', rel);
      if (fileExists(env, candidate)) {
        return candidate;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
  }
  const home = env.homedir();
  if (home.length > 0) {
    const candidate = path.join(home, '.claude', rel);
    if (fileExists(env, candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/** Whether a file (not directory) exists at `filePath`, via the listing seam. */
function fileExists(env: ClaudeFs, filePath: string): boolean {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  return env.readDir(dir).some((e) => e.isFile && e.name === base);
}

/** A plugin-namespaced skill id `plugin:skill` resolves against its bare name. */
function bareSkillName(skill: string): string {
  const colon = skill.lastIndexOf(':');
  return colon >= 0 ? skill.slice(colon + 1) : skill;
}

/** Read a string field off a tool_use `input` object, else `undefined`. */
function stringField(input: unknown, key: string): string | undefined {
  if (input === null || typeof input !== 'object') {
    return undefined;
  }
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Disambiguate entries that share a `name` by appending their parent directory,
 * e.g. two `CLAUDE.md` become `CLAUDE.md (agent-observability)` and
 * `CLAUDE.md (src)`. Unique names are left untouched.
 */
function uniquifyNames(entries: ContextFileEntry[]): ContextFileEntry[] {
  const counts = new Map<string, number>();
  for (const e of entries) {
    counts.set(e.name, (counts.get(e.name) ?? 0) + 1);
  }
  return entries.map((e) => {
    if ((counts.get(e.name) ?? 0) <= 1 || e.filePath === undefined) {
      return e;
    }
    const parent = path.basename(path.dirname(e.filePath));
    return { ...e, name: `${e.name} (${parent})` };
  });
}
