import * as fs from 'node:fs';
import * as path from 'node:path';
import { copilotCommandCandidates } from '@agent-observability/core/src/chat/backends/copilotCliArgs';

/**
 * Where the user's OWN installed Copilot CLI is, in the form the SDK can
 * launch. The app ships no Copilot runtime; this resolver is how it finds
 * theirs.
 *
 * Two shapes exist in the wild:
 * - a native executable (`copilot`, `copilot.exe`): used as-is;
 * - an npm install, whose `copilot` / `copilot.cmd` on PATH is a shim. A
 *   `.cmd` cannot be spawned without a shell (Node refuses with EINVAL, and
 *   the SDK does not use one), so the shim is resolved to the package's
 *   JavaScript entry. The SDK launches a `.js` path with `process.execPath`,
 *   which inside Electron is the app binary — hence `ELECTRON_RUN_AS_NODE`.
 *
 * On Windows only an `.exe` counts as native. Anything else named `copilot`
 * that is not an npm shim is a script that needs a shell, and is skipped so
 * the search goes on down PATH. This is not hypothetical: in a VS Code
 * terminal the Copilot Chat extension puts its own `copilot` wrapper (a
 * shell script beside a `.bat` and a `.ps1`) first on PATH, ahead of the
 * user's real install.
 *
 * Never a shell, on any path. Verified against @github/copilot-sdk 1.0.16 and
 * an npm install of the CLI on Windows (2026-10-06).
 */

export interface RuntimeTarget {
  /** What to hand `RuntimeConnection.forStdio({ path })`. */
  path: string;
  /** Extra environment the launch needs. */
  env: Record<string, string>;
  kind: 'native' | 'npm-entry';
}

export type RuntimeResolution = { target: RuntimeTarget } | { problem: string };

export interface RuntimePathSeams {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (p: string) => boolean;
  readText?: (p: string) => string | undefined;
  /** True when hosted by Electron, where `process.execPath` is not node. */
  electron?: boolean;
}

export const RUNTIME_NOT_FOUND =
  'GitHub Copilot CLI was not found. Install it (npm install -g @github/copilot) and sign in with `copilot`, or set its path under Settings > AI.';

const NPM_PACKAGE = ['node_modules', '@github', 'copilot'];

export function resolveRuntimeTarget(configuredPath: string, seams: RuntimePathSeams = {}): RuntimeResolution {
  const platform = seams.platform ?? process.platform;
  const env = seams.env ?? process.env;
  const isFile = seams.isFile ?? defaultIsFile;
  const readText = seams.readText ?? defaultReadText;
  const electron = seams.electron ?? process.versions.electron !== undefined;
  const nodeEnv: Record<string, string> = electron ? { ELECTRON_RUN_AS_NODE: '1' } : {};

  for (const candidate of locate(configuredPath, platform, env, isFile)) {
    const lower = candidate.toLowerCase();
    if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
      return { target: { path: candidate, env: nodeEnv, kind: 'npm-entry' } };
    }
    // An npm install puts a shim (with and without .cmd) beside node_modules.
    const entry = npmEntry(path.dirname(candidate), isFile, readText);
    if (entry !== undefined) {
      return { target: { path: entry, env: nodeEnv, kind: 'npm-entry' } };
    }
    if (platform === 'win32' && !lower.endsWith('.exe')) {
      // Not an npm shim and not an executable: a script (`.cmd`, `.bat`, or a
      // shell script with no extension) that cannot be launched without a
      // shell. Keep looking.
      continue;
    }
    return { target: { path: candidate, env: {}, kind: 'native' } };
  }
  return { problem: RUNTIME_NOT_FOUND };
}

/** Existing files matching the configured path, or `copilot` on PATH. */
function locate(
  configuredPath: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  isFile: (p: string) => boolean,
): string[] {
  const found: string[] = [];
  const names = copilotCommandCandidates(configuredPath, platform);
  const explicit = names.filter((name) => path.isAbsolute(name) || name.includes('/') || name.includes('\\'));
  if (explicit.length > 0) {
    for (const name of explicit) {
      if (isFile(name)) {
        found.push(name);
      }
    }
    return found;
  }
  const pathVar = env.PATH ?? env.Path ?? env.path ?? '';
  const dirs = pathVar.split(path.delimiter).filter((dir) => dir.length > 0);
  const variants = platform === 'win32' ? withWindowsExtensions(names) : names;
  for (const dir of dirs) {
    for (const name of variants) {
      const full = path.join(dir, name);
      if (isFile(full)) {
        found.push(full);
      }
    }
  }
  return found;
}

/** `.exe` first: a native install wins over a shim of the same name. */
function withWindowsExtensions(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (lower.endsWith('.cmd') || lower.endsWith('.exe') || lower.endsWith('.bat')) {
      out.push(name);
    } else {
      out.push(`${name}.exe`, name);
    }
  }
  return [...new Set(out)];
}

/** The JS entry of an npm-installed Copilot CLI whose shim lives in `shimDir`. */
function npmEntry(
  shimDir: string,
  isFile: (p: string) => boolean,
  readText: (p: string) => string | undefined,
): string | undefined {
  const packageDir = path.join(shimDir, ...NPM_PACKAGE);
  const manifest = readText(path.join(packageDir, 'package.json'));
  if (manifest === undefined) {
    return undefined;
  }
  let bin: unknown;
  try {
    bin = (JSON.parse(manifest) as { bin?: unknown }).bin;
  } catch {
    return undefined;
  }
  const relative =
    typeof bin === 'string'
      ? bin
      : bin !== null && typeof bin === 'object'
        ? (bin as Record<string, unknown>).copilot
        : undefined;
  if (typeof relative !== 'string' || relative.length === 0) {
    return undefined;
  }
  const entry = path.join(packageDir, relative);
  // The entry must stay inside the package; a manifest cannot point elsewhere.
  const inside = path.relative(packageDir, entry);
  if (inside.startsWith('..') || path.isAbsolute(inside)) {
    return undefined;
  }
  return isFile(entry) ? entry : undefined;
}

function defaultIsFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function defaultReadText(p: string): string | undefined {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return undefined;
  }
}
