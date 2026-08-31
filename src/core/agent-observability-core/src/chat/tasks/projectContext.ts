/**
 * Project context-file gathering for the "Generate workflows" task.
 *
 * Unlike the telemetry-grounded path, this derives the EXPECTED workflow from
 * what the project DECLARES — its Copilot customization files (instructions,
 * agents, prompts, skills). It reuses the same allowlist + repo scan as the
 * cloud context-insights path ({@link buildRepoCustomizationIndex}), then reads
 * the CONTENTS of each allowlisted file so the model can infer the intended
 * agents, their order, and the tools they use.
 *
 * PRIVACY NOTE: this is the one AI Helper path that sends file CONTENTS — the
 * user's own customization files to the user's own Copilot license, never via
 * the cloud-sync path. The one-time disclosure in the provider calls this out.
 *
 * Headless: imports only `node:fs`/`node:path` and sibling pure modules (never
 * `vscode`), so it runs under vitest with a temp-dir fixture.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildRepoCustomizationIndex,
  categoryForCustomizationFile,
} from '../../aggregate/customizationFilter';
import type { ContextFileCategory } from '../../context/models';
import { sanitizeRepositoryUrl, UNKNOWN_REPOSITORY } from '../../telemetry/repositoryUrl';

/** Bounds so a large repo can never blow the model's token budget. */
export interface GatherLimits {
  /** Maximum number of files whose contents are included. */
  maxFiles: number;
  /** Maximum characters read from a single file (the rest is truncated). */
  maxFileChars: number;
  /** Maximum characters across all included file bodies. */
  maxTotalChars: number;
}

/** Default bounds (~12k tokens of file bodies at ~4 chars/token). */
export const DEFAULT_GATHER_LIMITS: GatherLimits = {
  maxFiles: 24,
  maxFileChars: 8_000,
  maxTotalChars: 48_000,
};

/** One project customization file with its (possibly truncated) contents. */
export interface ProjectContextFile {
  /** Repo-relative POSIX path (allowlisted, e.g. `.github/agents/planner.agent.md`). */
  path: string;
  category: ContextFileCategory;
  /** File body, decoded UTF-8, truncated to the per-file/total budget. */
  content: string;
  /** True when `content` was cut short by a budget. */
  truncated: boolean;
}

/**
 * Resolve the open workspace's repository to the SAME canonical string the
 * deviation detector compares against (via {@link sanitizeRepositoryUrl}), by
 * reading the `origin` remote from the repo's git config. Returns
 * {@link UNKNOWN_REPOSITORY} when there is no workspace, no git repo, or no
 * usable remote. Handles linked worktrees, where `.git` is a file pointing at
 * the worktree git dir whose `commondir` holds the shared `config`.
 */
export function resolveWorkspaceRepository(workspaceCwd: string | undefined): string {
  const configPath = findGitConfigPath(workspaceCwd);
  if (configPath === undefined) {
    return UNKNOWN_REPOSITORY;
  }
  let text: string;
  try {
    text = fs.readFileSync(configPath, 'utf8');
  } catch {
    return UNKNOWN_REPOSITORY;
  }
  return sanitizeRepositoryUrl(parseRemoteUrl(text));
}

/**
 * Gather the project's customization files (contents included), bounded by
 * {@link GatherLimits}. Returns an empty array when there is no workspace or no
 * allowlisted files exist. Never throws — unreadable files are skipped.
 */
export function gatherProjectContextFiles(
  workspaceCwd: string | undefined,
  limits: GatherLimits = DEFAULT_GATHER_LIMITS,
): ProjectContextFile[] {
  if (workspaceCwd === undefined || workspaceCwd.trim().length === 0) {
    return [];
  }
  const root = path.resolve(workspaceCwd);
  const index = buildRepoCustomizationIndex(root);

  // The index keys both base name and stem to the same paths; flatten to the
  // unique set of repo-relative paths and order them deterministically.
  const relPaths = [...new Set([...index.byKey.values()].flat())].sort();

  const files: ProjectContextFile[] = [];
  let totalChars = 0;
  for (const rel of relPaths) {
    if (files.length >= limits.maxFiles || totalChars >= limits.maxTotalChars) {
      break;
    }
    const category = categoryForCustomizationFile(rel);
    if (category === 'unknown') {
      continue;
    }
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(root, rel), 'utf8');
    } catch {
      continue; // unreadable file degrades gracefully — skip it
    }
    const remaining = Math.max(0, limits.maxTotalChars - totalChars);
    const budget = Math.min(limits.maxFileChars, remaining);
    const truncated = raw.length > budget;
    const content = truncated ? raw.slice(0, budget) : raw;
    totalChars += content.length;
    files.push({ path: rel, category, content, truncated });
  }
  return files;
}

/** The fence-free delimiter wrapping each file body in the digest (avoids fence collisions). */
const FILE_OPEN = '----- BEGIN FILE';
const FILE_CLOSE = '----- END FILE -----';

/**
 * Build the grounding digest for workflow generation: the resolved repository
 * plus each context file's path, category, and (bounded) contents. Pure.
 */
export function buildContextFilesDigest(
  repository: string,
  files: readonly ProjectContextFile[],
): string {
  const repoLine =
    repository === UNKNOWN_REPOSITORY
      ? `## Project repository\nUnknown — the workspace has no detectable git remote. Use \`"${UNKNOWN_REPOSITORY}"\` as the \`repository\` value.`
      : `## Project repository\n${repository}`;

  if (files.length === 0) {
    return [
      repoLine,
      '',
      '## Project context files',
      'No Copilot customization files (instructions, agents, prompts, skills) were found in the open workspace.',
    ].join('\n');
  }

  const sections = files.map((f) => {
    const note = f.truncated ? ' (truncated)' : '';
    return [
      `${FILE_OPEN}: ${f.path} (category: ${f.category})${note} -----`,
      f.content,
      FILE_CLOSE,
    ].join('\n');
  });

  return [
    repoLine,
    '',
    '## Project context files',
    'The following Copilot customization files were found in the open workspace. Their CONTENTS are',
    'included so you can infer the intended agents, the order they run in, and the tools they use.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

/** How many directories {@link findRepoRoot} will walk up before giving up. */
const REPO_ROOT_MAX_ASCENT = 12;

/**
 * Walk up from `startDir` to the first directory containing a `.git` entry —
 * the repository root. Claude session cwds are often subdirectories of the
 * checkout, and hotspot file paths always are; the context-file scan and the
 * improvement-plan write path both need the actual root. Returns `undefined`
 * when no `.git` is found within the ascent bound.
 */
export function findRepoRoot(startDir: string): string | undefined {
  let current = path.resolve(startDir);
  for (let step = 0; step <= REPO_ROOT_MAX_ASCENT; step += 1) {
    try {
      fs.statSync(path.join(current, '.git'));
      return current;
    } catch {
      // Not here — keep climbing.
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Internals

/**
 * Extract the `origin` remote URL from git config text, falling back to the
 * first remote with a URL. Returns `undefined` when no remote URL is present.
 */
export function parseRemoteUrl(configText: string): string | undefined {
  let section: string | undefined;
  let firstRemoteUrl: string | undefined;
  let originUrl: string | undefined;

  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const header = /^\[\s*remote\s+"([^"]+)"\s*\]$/i.exec(line);
    if (header) {
      section = header[1];
      continue;
    }
    if (line.startsWith('[')) {
      section = undefined; // a non-remote section
      continue;
    }
    if (section === undefined) {
      continue;
    }
    const urlMatch = /^url\s*=\s*(.+)$/i.exec(line);
    if (!urlMatch) {
      continue;
    }
    const url = urlMatch[1].trim();
    if (url.length === 0) {
      continue;
    }
    if (firstRemoteUrl === undefined) {
      firstRemoteUrl = url;
    }
    if (section === 'origin') {
      originUrl = url;
    }
  }
  return originUrl ?? firstRemoteUrl;
}

/**
 * Locate the effective git config file for `workspaceCwd`, handling both a
 * normal repo (`.git/` directory) and a linked worktree (`.git` file pointing
 * at the worktree git dir, whose `commondir` resolves the shared config).
 * Returns `undefined` when no git dir can be found.
 */
function findGitConfigPath(workspaceCwd: string | undefined): string | undefined {
  if (workspaceCwd === undefined || workspaceCwd.trim().length === 0) {
    return undefined;
  }
  const dotGit = path.join(path.resolve(workspaceCwd), '.git');
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dotGit);
  } catch {
    return undefined;
  }

  let gitDir: string;
  if (stat.isDirectory()) {
    gitDir = dotGit;
  } else if (stat.isFile()) {
    // Worktree/submodule: `.git` is `gitdir: <path>`.
    let pointer: string;
    try {
      pointer = fs.readFileSync(dotGit, 'utf8');
    } catch {
      return undefined;
    }
    const match = /^gitdir:\s*(.+)$/m.exec(pointer.trim());
    if (!match) {
      return undefined;
    }
    gitDir = path.resolve(path.dirname(dotGit), match[1].trim());
  } else {
    return undefined;
  }

  // A worktree git dir carries a `commondir` pointing at the shared git dir,
  // which holds the `config` (and thus the remotes).
  const commonDirFile = path.join(gitDir, 'commondir');
  let commonDir = gitDir;
  try {
    const rel = fs.readFileSync(commonDirFile, 'utf8').trim();
    if (rel.length > 0) {
      commonDir = path.resolve(gitDir, rel);
    }
  } catch {
    // No commondir → a normal git dir; config lives here.
  }
  return path.join(commonDir, 'config');
}
