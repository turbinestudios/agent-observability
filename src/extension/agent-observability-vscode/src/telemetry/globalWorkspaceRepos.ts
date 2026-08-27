import * as fs from 'node:fs';
import * as path from 'node:path';
import { UNKNOWN_REPOSITORY } from './repositoryUrl';
import { WorkspaceStoreIo, listChatSessionIds } from './workspaceStore';

/**
 * CROSS-workspace `chat-session id → repository` fallback map.
 *
 * The repo attribute on telemetry spans is sparse, and the live workspace
 * context can only claim the CURRENT window's sessions — so a session recorded
 * in any OTHER workspace (captured centrally by the OTLP receiver / archive no
 * matter which window ran it) used to sit in the `unknown` bucket forever, and
 * its repository never appeared in the tree at all.
 *
 * VS Code keeps every workspace's chat-session store CLIENT-side under
 * `<userData>/User/workspaceStorage/<hash>/` — including stores for WSL/remote
 * windows — next to a `workspace.json` naming the folder. Walking all of them
 * yields (folder → its sanitized git remote) × (its chat-session ids), which is
 * exactly the map the repository fallback needs.
 *
 * LOCAL-only: reads workspace metadata, chat-session FILENAMES (never their
 * contents), and `.git/config` remotes, all through the same sanitizing
 * chokepoints as every other repo value. Nothing here touches the sync path.
 */

/** Filesystem seam: the store reader's IO plus directory enumeration. */
export interface GlobalWorkspaceReposIo extends WorkspaceStoreIo {
  /** Immediate subdirectory NAMES of `root`, `[]` when absent/unreadable. */
  listDirectories(root: string): string[];
}

const defaultIo: GlobalWorkspaceReposIo = {
  listDirectories: (root) => {
    try {
      return fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
  },
  listChatSessionFiles: (dir) => {
    try {
      return fs.readdirSync(dir);
    } catch {
      return [];
    }
  },
  statMtimeMs: (filePath) => {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return undefined;
    }
  },
  readFile: (filePath) => {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return undefined;
    }
  },
};

/**
 * Translate a `workspace.json` folder/workspace URI into a path this machine
 * can read, or `undefined` when it cannot be reached from here:
 *
 * - `file:///c%3A/dir` → `c:\dir` (and `file:///home/u` → `/home/u`);
 * - `vscode-remote://wsl%2B<distro>/<path>` → `\\wsl$\<distro>\<path>` — WSL
 *   filesystems are reachable from the host over UNC;
 * - other remote authorities (ssh, containers) → `undefined`.
 */
export function workspaceFolderLocalPath(folderUri: string): string | undefined {
  const file = /^file:\/\/\/(.+)$/i.exec(folderUri);
  if (file !== null) {
    const decoded = safeDecode(file[1]);
    if (decoded === undefined) {
      return undefined;
    }
    return /^[A-Za-z]:/.test(decoded) ? path.normalize(decoded) : path.normalize(`/${decoded}`);
  }
  const remote = /^vscode-remote:\/\/([^/]+)(\/.*)$/i.exec(folderUri);
  if (remote !== null) {
    const authority = safeDecode(remote[1]);
    if (authority === undefined) {
      return undefined;
    }
    const wsl = /^wsl\+(.+)$/i.exec(authority);
    if (wsl === null) {
      return undefined;
    }
    return `\\\\wsl$\\${wsl[1]}${remote[2].replace(/\//g, '\\')}`;
  }
  return undefined;
}

function safeDecode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * Build the global `lowercased chat-session id → sanitized repository` map from
 * every workspace store under `workspaceStorageRoot`. `resolveRepository` maps a
 * local folder path to its sanitized git remote (pass a shared, caching
 * `GitRemoteResolver.resolve`); folders that resolve to `unknown` contribute
 * nothing. Resilient: an unreadable store or unparseable metadata is skipped.
 */
export function buildGlobalSessionRepositories(
  workspaceStorageRoot: string,
  resolveRepository: (localPath: string) => string,
  io: GlobalWorkspaceReposIo = defaultIo,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const dir of io.listDirectories(workspaceStorageRoot)) {
    const hashDir = path.join(workspaceStorageRoot, dir);
    const meta = io.readFile(path.join(hashDir, 'workspace.json'));
    if (meta === undefined) {
      continue;
    }
    let uri: unknown;
    try {
      const parsed = JSON.parse(meta) as { folder?: unknown; workspace?: unknown };
      uri = parsed.folder ?? parsed.workspace;
    } catch {
      continue;
    }
    if (typeof uri !== 'string') {
      continue;
    }
    const localPath = workspaceFolderLocalPath(uri);
    if (localPath === undefined) {
      continue;
    }
    // Enumerate sessions BEFORE resolving the remote: a store with no chat
    // sessions must not pay for a (possibly slow, UNC) `.git` walk.
    const ids = listChatSessionIds(hashDir, io);
    if (ids.size === 0) {
      continue;
    }
    const repository = resolveRepository(localPath);
    if (repository === UNKNOWN_REPOSITORY) {
      continue;
    }
    for (const id of ids) {
      if (!map.has(id)) {
        map.set(id, repository);
      }
    }
  }
  return map;
}
