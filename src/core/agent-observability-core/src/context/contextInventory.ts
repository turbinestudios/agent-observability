/**
 * On-disk inventory of a repository's agent context files: the rules, memory
 * files, instructions, skills, agent definitions and prompts that Claude Code
 * and Copilot pick up from a checkout.
 *
 * This is the "Rules & Skills" tab of the Workspace repository hub. It is
 * deliberately broader than {@link ../aggregate/customizationFilter}'s upload
 * allowlist (that one is the privacy gate for the context-insights contract,
 * and misses `.claude/rules/*.md`, `.agents/roles/*.md` and `CLAUDE.local.md`,
 * none of which may ever be uploaded) and deliberately LOCAL-ONLY: the
 * inventory shows the user their own checkout and never feeds the aggregate
 * or sync paths.
 *
 * File CONTENTS are never read. Only directory listings and sizes are used, so
 * the walk stays cheap and the module has nothing to leak. Imports only
 * `node:fs` / `node:path`, never `vscode`, like the filter it reuses bounds from.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONTEXT_DIRS,
  EXCLUDE_DIRS,
  MAX_DEPTH,
  MAX_SCAN_FILES,
  ROOT_FILES,
  toRepoRelative,
} from '../aggregate/customizationFilter';

/** What a context file is for, by convention of its name and location. */
export type InventoryKind = 'memory' | 'rule' | 'instruction' | 'skill' | 'agent' | 'prompt';

/** Which agent reads the file; `shared` when both conventions honour it. */
export type InventoryAgent = 'claude' | 'copilot' | 'shared';

export interface InventoryFile {
  /** Repo-relative POSIX path (`/` separators on every platform). */
  relPath: string;
  kind: InventoryKind;
  agent: InventoryAgent;
  /** Size on disk. Contents are never read. */
  bytes: number;
  /** `ceil(bytes / 4)`: the same rough chars-per-token estimate the analyzers use. */
  estTokens: number;
}

export interface ContextInventory {
  /** Sorted by `relPath`. */
  files: InventoryFile[];
  /** True when the walk hit the file budget and may have missed files. */
  truncated: boolean;
}

/** Repo-root files worth listing beyond the upload allowlist's `ROOT_FILES`. */
const EXTRA_ROOT_FILES: readonly string[] = ['CLAUDE.local.md'];

/** Filesystem seam so the walk is testable on a temp tree without mocking modules. */
export interface InventoryFs {
  readDir(dir: string): { name: string; isDirectory: boolean; isFile: boolean }[];
  /** Size in bytes of a regular file, or `undefined` when missing / not a file. */
  fileSize(p: string): number | undefined;
}

export const defaultInventoryFs: InventoryFs = {
  readDir: (dir) => {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .map((e) => ({ name: e.name, isDirectory: e.isDirectory(), isFile: e.isFile() }));
    } catch {
      return [];
    }
  },
  fileSize: (p) => {
    try {
      const stat = fs.statSync(p);
      return stat.isFile() ? stat.size : undefined;
    } catch {
      return undefined;
    }
  },
};

/**
 * Classify a repo-relative POSIX path, or `undefined` when it is not a known
 * context file. Pure, case-insensitive on the file name, exact on directory
 * conventions.
 */
export function classifyInventoryPath(
  relPosix: string,
): { kind: InventoryKind; agent: InventoryAgent } | undefined {
  const segments = relPosix.split('/').filter((s) => s.length > 0);
  if (segments.length === 0) {
    return undefined;
  }
  const base = segments[segments.length - 1];
  const lower = base.toLowerCase();
  const dirs = segments.slice(0, -1);
  const [first, second] = dirs;

  if (lower === 'claude.md' || lower === 'claude.local.md') {
    return { kind: 'memory', agent: 'claude' };
  }
  if (lower === 'agents.md') {
    return { kind: 'memory', agent: 'shared' };
  }
  if (lower === 'copilot-instructions.md' && (dirs.length === 0 || (dirs.length === 1 && first === '.github'))) {
    return { kind: 'instruction', agent: 'copilot' };
  }
  if (lower.endsWith('.md') && first === '.claude' && second === 'rules') {
    return { kind: 'rule', agent: 'claude' };
  }
  if (lower.endsWith('.instructions.md')) {
    return { kind: 'instruction', agent: 'copilot' };
  }
  if (lower === 'skill.md' && dirs.length === 3 && second === 'skills') {
    if (first === '.claude' || first === '.agents') {
      return { kind: 'skill', agent: 'claude' };
    }
    if (first === '.github' || first === '.copilot') {
      return { kind: 'skill', agent: 'copilot' };
    }
  }
  if (lower.endsWith('.md') && dirs.length === 2 && first === '.claude' && second === 'agents') {
    return { kind: 'agent', agent: 'claude' };
  }
  if (lower.endsWith('.agent.md')) {
    return { kind: 'agent', agent: 'copilot' };
  }
  if (lower.endsWith('.md') && dirs.length === 2 && first === '.agents' && second === 'roles') {
    return { kind: 'agent', agent: 'shared' };
  }
  if (lower.endsWith('.prompt.md')) {
    return { kind: 'prompt', agent: 'copilot' };
  }
  if (lower.endsWith('.skill.md')) {
    return { kind: 'skill', agent: 'shared' };
  }
  return undefined;
}

/**
 * Walk the repo-root context files and the conventional context directories
 * under `root` and list every classified file. Bounded by the same depth and
 * file budget as the upload-side scan, skipping the same build/output folders.
 */
export function scanContextInventory(root: string, fsSeam: InventoryFs = defaultInventoryFs): ContextInventory {
  const resolvedRoot = path.resolve(root);
  const files: InventoryFile[] = [];
  const budget = { files: 0, truncated: false };

  const consider = (absPath: string): void => {
    const rel = toRepoRelative(resolvedRoot, absPath);
    if (rel === undefined) {
      return;
    }
    const classified = classifyInventoryPath(rel);
    if (classified === undefined) {
      return;
    }
    const bytes = fsSeam.fileSize(absPath);
    if (bytes === undefined) {
      return;
    }
    files.push({ relPath: rel, kind: classified.kind, agent: classified.agent, bytes, estTokens: Math.ceil(bytes / 4) });
  };

  for (const name of [...ROOT_FILES, ...EXTRA_ROOT_FILES]) {
    consider(path.join(resolvedRoot, name));
  }
  for (const dir of CONTEXT_DIRS) {
    walk(path.join(resolvedRoot, dir), 0, budget, fsSeam, consider);
  }

  files.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return { files, truncated: budget.truncated };
}

function walk(
  dir: string,
  depth: number,
  budget: { files: number; truncated: boolean },
  fsSeam: InventoryFs,
  onFile: (absPath: string) => void,
): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  if (budget.files >= MAX_SCAN_FILES) {
    budget.truncated = true;
    return;
  }
  for (const entry of fsSeam.readDir(dir)) {
    if (budget.files >= MAX_SCAN_FILES) {
      budget.truncated = true;
      return;
    }
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory) {
      if (EXCLUDE_DIRS.has(entry.name) || entry.name.startsWith('.git')) {
        continue;
      }
      walk(abs, depth + 1, budget, fsSeam, onFile);
    } else if (entry.isFile) {
      budget.files += 1;
      onFile(abs);
    }
  }
}
