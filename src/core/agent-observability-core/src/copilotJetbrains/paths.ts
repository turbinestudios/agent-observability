import * as path from 'node:path';
import { defaultCopilotCliFs, type CopilotCliFs } from '../copilotCli/paths';

/**
 * Where the GitHub Copilot plugin for JetBrains IDEs (Rider, IntelliJ IDEA,
 * PyCharm, …) keeps its chat history:
 *
 *   <root>/<ide>/<kind>/<storeId>/copilot-*-nitrite.db
 *
 * `<root>` is `%LOCALAPPDATA%\github-copilot` on Windows and
 * `$XDG_CONFIG_HOME/github-copilot` (else `~/.config/github-copilot`)
 * elsewhere. `<kind>` is one of the three chat stores below. The same root also
 * holds Copilot for Visual Studio's auth and symbol databases and the
 * plugin's `bg-agent-sessions` snapshots; neither matches, so neither is read.
 *
 * NOT VERIFIED ON DISK: no JetBrains IDE was installed where this was
 * written. The layout comes from codeburn's provider notes
 * (github.com/getagentseal/codeburn, docs/providers/copilot.md, MIT). The
 * store path can be overridden in Settings for exactly that reason.
 *
 * Read-only by rule: nothing here writes or deletes under the plugin's root.
 */

export const JETBRAINS_CHAT_KINDS = ['chat-agent-sessions', 'chat-sessions', 'chat-edit-sessions'] as const;
export type JetbrainsChatKind = (typeof JETBRAINS_CHAT_KINDS)[number];

const STORE_FILE = /^copilot-.*nitrite\.db$/i;

/** The host seam is the CLI's, plus the platform (the root differs by OS). */
export type JetbrainsFs = CopilotCliFs & { platform?: NodeJS.Platform };

export interface JetbrainsStoreFile {
  path: string;
  /** The IDE folder name as written by the plugin, e.g. `Rider2026.2` or `iu`. */
  ide: string;
  kind: JetbrainsChatKind;
  size: number;
  mtimeMs: number;
}

export function copilotJetbrainsRoot(override?: string, env: JetbrainsFs = defaultCopilotCliFs): string {
  if (override !== undefined && override.trim().length > 0) {
    return path.normalize(override.trim());
  }
  const platform = env.platform ?? process.platform;
  if (platform === 'win32') {
    const local = env.env.LOCALAPPDATA;
    const base = local !== undefined && local.trim().length > 0 ? local.trim() : path.join(env.homedir(), 'AppData', 'Local');
    return path.join(base, 'github-copilot');
  }
  const xdg = env.env.XDG_CONFIG_HOME;
  const base = xdg !== undefined && xdg.trim().length > 0 ? xdg.trim() : path.join(env.homedir(), '.config');
  return path.join(base, 'github-copilot');
}

/**
 * Every chat store file under the root, newest first. A store file may sit
 * directly in the kind folder or one level down in a per-project folder.
 */
export function discoverJetbrainsStores(override?: string, env: JetbrainsFs = defaultCopilotCliFs): JetbrainsStoreFile[] {
  const root = copilotJetbrainsRoot(override, env);
  const stores: JetbrainsStoreFile[] = [];
  const add = (file: string, ide: string, kind: JetbrainsChatKind): void => {
    const stat = env.stat(file);
    if (stat !== undefined && stat.size > 0) {
      stores.push({ path: file, ide, kind, size: stat.size, mtimeMs: stat.mtimeMs });
    }
  };
  for (const ide of env.readDir(root)) {
    if (!ide.isDirectory) {
      continue;
    }
    for (const kind of JETBRAINS_CHAT_KINDS) {
      const kindDir = path.join(root, ide.name, kind);
      for (const entry of env.readDir(kindDir)) {
        if (entry.isFile && STORE_FILE.test(entry.name)) {
          add(path.join(kindDir, entry.name), ide.name, kind);
        } else if (entry.isDirectory) {
          for (const inner of env.readDir(path.join(kindDir, entry.name))) {
            if (inner.isFile && STORE_FILE.test(inner.name)) {
              add(path.join(kindDir, entry.name, inner.name), ide.name, kind);
            }
          }
        }
      }
    }
  }
  return stores.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/**
 * A readable IDE name from the plugin's folder name: product codes (`rd`,
 * `iu`) and versioned names (`Rider2026.2`, `PyCharm2025.2`) both occur.
 */
export function jetbrainsIdeName(folder: string): string {
  const name = folder.replace(/[\d.]+$/, '');
  const key = name.toLowerCase();
  const byCode: Record<string, string> = {
    rd: 'Rider',
    rider: 'Rider',
    iu: 'IntelliJ IDEA',
    ic: 'IntelliJ IDEA',
    intellij: 'IntelliJ IDEA',
    intellijidea: 'IntelliJ IDEA',
    ideaic: 'IntelliJ IDEA',
    ideaiu: 'IntelliJ IDEA',
    py: 'PyCharm',
    pc: 'PyCharm',
    pycharm: 'PyCharm',
    ws: 'WebStorm',
    webstorm: 'WebStorm',
    go: 'GoLand',
    goland: 'GoLand',
    cl: 'CLion',
    clion: 'CLion',
    ps: 'PhpStorm',
    phpstorm: 'PhpStorm',
    rm: 'RubyMine',
    rubymine: 'RubyMine',
    db: 'DataGrip',
    dg: 'DataGrip',
    datagrip: 'DataGrip',
    ai: 'Android Studio',
    androidstudio: 'Android Studio',
    rr: 'RustRover',
    rustrover: 'RustRover',
  };
  return byCode[key] ?? (name.length > 0 ? name : 'JetBrains IDE');
}
