/**
 * Customization-file allowlist + repo-relative path resolver — PRODUCER-SIDE
 * privacy filter for the context-insights upload path.
 *
 * The context-insights batch is the first contract to convey repo-relative file
 * PATHS to the cloud, so this module is the single place that decides:
 *  1. whether a discovered context file is an allowlisted CUSTOMIZATION file
 *     (instructions / skills / prompts / agents) vs. an arbitrary source file, and
 *  2. its REPO-RELATIVE POSIX path, resolved against the developer's open
 *     workspace — enforcing "repo-scoped only" by dropping anything that does not
 *     resolve to a customization file inside the repo (e.g. user/global-scope
 *     prompts in the VS Code user folder).
 *
 * It imports only `node:fs` / `node:path` (never `vscode`) so the sync engine
 * stays headless and unit-testable. File CONTENTS are never read here — only
 * directory listings to map a discovered file name to its in-repo path.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ContextFileCategory } from '../context/models';

/** Repo subdirectories conventionally holding Copilot customization files. */
export const CONTEXT_DIRS: readonly string[] = ['.github', '.copilot', '.claude', '.agents'];

/** Repo-root customization files that may live outside the context dirs. */
export const ROOT_FILES: readonly string[] = ['AGENTS.md', 'CLAUDE.md', 'copilot-instructions.md'];

/** Directory names never descended into during the repo scan. */
const EXCLUDE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.vs',
  '.vscode',
  'bin',
  'obj',
  'dist',
  'out',
  'build',
  'target',
  'coverage',
]);

/** Hard bounds so a pathological tree can never make a background sync hang. */
const MAX_SCAN_FILES = 5000;
const MAX_DEPTH = 12;

/**
 * The single source of truth for a SAFE repo-relative customization path. Mirrors
 * the `contextFile` pattern in `schemas/context-insights-batch.schema.json`
 * EXACTLY: relative-only (no leading '/', drive letter, or backslash), no `..`
 * segments, safe segment charset, and an allowlisted customization filename.
 */
export const SAFE_CONTEXT_FILE_PATTERN =
  /^(?!.*(?:^|\/)\.\.(?:\/|$))(?:[A-Za-z0-9_.-]+\/)*(?:[A-Za-z0-9_.-]+\.(?:instructions|prompt|agent|skill)\.md|copilot-instructions\.md|AGENTS\.md|CLAUDE\.md|SKILL\.md)$/;

/** True when a repo-relative POSIX path is a safe, allowlisted customization path. */
export function isSafeContextFilePath(relativePath: string): boolean {
  return SAFE_CONTEXT_FILE_PATTERN.test(relativePath);
}

/** True when a bare file name matches the customization allowlist (suffix/known root). */
export function isCustomizationFileName(name: string): boolean {
  const base = baseName(name).toLowerCase();
  return (
    /\.(instructions|prompt|agent|skill)\.md$/.test(base) ||
    base === 'copilot-instructions.md' ||
    base === 'agents.md' ||
    base === 'claude.md' ||
    base === 'skill.md'
  );
}

/**
 * Best-effort category for an allowlisted customization file, used only as a
 * fallback when the discovery event did not classify the entry. Returns
 * `'unknown'` for anything not on the allowlist (such rows are dropped upstream).
 */
export function categoryForCustomizationFile(name: string): ContextFileCategory {
  const base = baseName(name).toLowerCase();
  if (base.endsWith('.instructions.md') || base === 'copilot-instructions.md' || base === 'claude.md') {
    return 'instruction';
  }
  if (base.endsWith('.prompt.md')) return 'prompt';
  if (base.endsWith('.agent.md') || base === 'agents.md') return 'agent';
  if (base.endsWith('.skill.md') || base === 'skill.md') return 'skill';
  return 'unknown';
}

/**
 * An index of the customization files that physically exist in the open
 * workspace, keyed by both full base name and "stem" (suffix-stripped) so a
 * discovery event naming a file either way (`x.instructions.md` or `x`) resolves.
 * Each key maps to the set of repo-relative POSIX paths that match it; ambiguous
 * (multi-path) keys are not resolved, to avoid mis-attribution.
 */
export interface RepoCustomizationIndex {
  byKey: ReadonlyMap<string, readonly string[]>;
}

/** An empty index (used when there is no workspace to scan). */
export const EMPTY_REPO_INDEX: RepoCustomizationIndex = { byKey: new Map() };

/**
 * Scan the open workspace for customization files and build a {@link RepoCustomizationIndex}.
 * Only the conventional context directories and repo-root files are walked, with
 * common build/output folders excluded and hard depth/file bounds applied. Never
 * reads file contents.
 */
export function buildRepoCustomizationIndex(workspaceCwd: string | undefined): RepoCustomizationIndex {
  if (workspaceCwd === undefined || workspaceCwd.trim().length === 0) {
    return EMPTY_REPO_INDEX;
  }

  const root = path.resolve(workspaceCwd);
  const matches = new Map<string, Set<string>>();
  const budget = { files: 0 };

  const addMatch = (absPath: string): void => {
    const rel = toRepoRelative(root, absPath);
    if (rel === undefined || !isSafeContextFilePath(rel)) {
      return;
    }
    for (const key of indexKeysForBaseName(baseName(rel))) {
      let set = matches.get(key);
      if (set === undefined) {
        set = new Set<string>();
        matches.set(key, set);
      }
      set.add(rel);
    }
  };

  // Repo-root customization files (e.g. AGENTS.md) that live outside context dirs.
  for (const rootFile of ROOT_FILES) {
    const abs = path.join(root, rootFile);
    if (safeIsFile(abs)) {
      addMatch(abs);
    }
  }

  // Conventional context directories, walked recursively within bounds.
  for (const dir of CONTEXT_DIRS) {
    walkDir(path.join(root, dir), 0, budget, addMatch);
  }

  const byKey = new Map<string, readonly string[]>();
  for (const [key, set] of matches) {
    byKey.set(key, [...set].sort());
  }
  return { byKey };
}

/**
 * Resolve a discovered context file to a unique repo-relative POSIX path, or
 * `undefined` when it cannot be safely attributed to a single in-repo
 * customization file (which is how user/global-scope and ambiguous files are
 * dropped).
 *
 * @param name      the discovery event's file name (may be a short stem or a base name)
 * @param filePath  an absolute path when known (tool-read entries); preferred when inside the repo
 */
export function resolveRepoRelativePath(
  name: string,
  filePath: string | undefined,
  workspaceCwd: string | undefined,
  index: RepoCustomizationIndex,
): string | undefined {
  // 1. Prefer an absolute path that resolves inside the repo (tool reads).
  if (filePath !== undefined && filePath.trim().length > 0 && workspaceCwd !== undefined) {
    const rel = toRepoRelative(path.resolve(workspaceCwd), path.resolve(filePath));
    if (rel !== undefined && isSafeContextFilePath(rel)) {
      return rel;
    }
  }

  // 2. Otherwise resolve the name against the in-repo customization index.
  const candidates = new Set<string>();
  for (const key of lookupKeysForName(name)) {
    const paths = index.byKey.get(key);
    if (paths !== undefined) {
      for (const p of paths) candidates.add(p);
    }
  }
  if (filePath !== undefined) {
    for (const key of lookupKeysForName(baseName(filePath))) {
      const paths = index.byKey.get(key);
      if (paths !== undefined) {
        for (const p of paths) candidates.add(p);
      }
    }
  }

  // Unique match only — ambiguous names are intentionally not attributed.
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

// ---------------------------------------------------------------------------
// Internals

/** Index keys for a known repo file's base name: the full base name and its stem. */
function indexKeysForBaseName(base: string): string[] {
  const lower = base.toLowerCase();
  const keys = new Set<string>([lower, stemOf(lower)]);
  return [...keys];
}

/** Candidate lookup keys for a discovery-event name (base name + stem variants). */
function lookupKeysForName(name: string): string[] {
  const base = baseName(name.trim()).toLowerCase();
  if (base.length === 0) return [];
  const keys = new Set<string>([base, stemOf(base)]);
  return [...keys];
}

/** Strip a trailing `.md` and any customization sub-suffix to get a stable stem. */
function stemOf(lowerBase: string): string {
  return lowerBase.replace(/\.md$/, '').replace(/\.(instructions|prompt|agent|skill)$/, '');
}

/** Last path segment, treating both `/` and `\` as separators. */
function baseName(p: string): string {
  const segments = p.replace(/\\/g, '/').split('/');
  return segments[segments.length - 1] ?? p;
}

/** Convert an absolute path under `root` to a repo-relative POSIX path, or undefined when outside. */
function toRepoRelative(root: string, absPath: string): string | undefined {
  const rel = path.relative(root, absPath);
  if (rel.length === 0 || rel.startsWith('..') || path.isAbsolute(rel)) {
    return undefined;
  }
  return rel.replace(/\\/g, '/');
}

/** Recursively walk `dir`, invoking `onFile` for each customization file found. */
function walkDir(
  dir: string,
  depth: number,
  budget: { files: number },
  onFile: (absPath: string) => void,
): void {
  if (depth > MAX_DEPTH || budget.files >= MAX_SCAN_FILES) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // dir missing or unreadable — nothing to index
  }
  for (const entry of entries) {
    if (budget.files >= MAX_SCAN_FILES) return;
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.git')) {
        continue;
      }
      walkDir(abs, depth + 1, budget, onFile);
    } else if (entry.isFile()) {
      budget.files += 1;
      if (isCustomizationFileName(entry.name)) {
        onFile(abs);
      }
    }
  }
}

/** Safe `fs.statSync().isFile()` that swallows missing-path errors. */
function safeIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
