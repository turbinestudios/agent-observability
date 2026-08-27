import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { parseSessionTitle } from '@agent-observability/core/src/telemetry/sessionTitles';
import { parseChatSessionIndex } from '@agent-observability/core/src/telemetry/chatSessionIndex';
import { titleStorageDirs } from '@agent-observability/core/src/telemetry/titleStore';
import { resolveDatabasePaths } from '@agent-observability/core/src/telemetry/paths';
import type { Configuration } from '@agent-observability/core/src/config/configuration';
import type { IndexDb } from './indexDb';

/**
 * Human-readable names for Copilot sessions, read incrementally.
 *
 * These live one-per-file under every workspace's `chatSessions` folder, and
 * the title is on the first line. The extension reads all of them, in full, on
 * every refresh — 910 files and 3.8 GB on this machine, the single largest cost
 * in showing a session list, and it repeats.
 *
 * Two changes make it cheap. A file whose mtime has not moved is not reopened
 * at all, so a steady state costs one `stat` per file. And a file that has
 * changed is read only up to {@link HEAD_BYTES}, since everything after the
 * first line is transcript content nobody here needs — which is what keeps a
 * 293 MB chat log from being pulled into memory to read its name.
 */

/**
 * How much of a chat-session file to read. The title is on line one; this is
 * generous enough for a long first line without ever reading a whole file.
 */
const HEAD_BYTES = 64 * 1024;

export interface TitleInfo {
  title: string;
  derived: boolean;
}

/**
 * Titles for every known session, refreshing the persisted index first. Returns
 * the full set, including ones carried over from previous runs.
 */
export function readCopilotTitles(db: IndexDb, config: Configuration): Map<string, TitleInfo> {
  const sourcePaths = resolveDatabasePaths(config).databases.map((d) => d.path);
  for (const dir of titleStorageDirs(sourcePaths)) {
    refreshDirectory(db, dir);
  }
  return db.allTitles();
}

function refreshDirectory(db: IndexDb, workspaceStorageDir: string): void {
  let hashes: string[];
  try {
    hashes = fs.readdirSync(workspaceStorageDir);
  } catch {
    return; // absent or unreadable; nothing to add
  }

  for (const hash of hashes) {
    refreshStateDb(db, path.join(workspaceStorageDir, hash, 'state.vscdb'));

    const chatSessions = path.join(workspaceStorageDir, hash, 'chatSessions');
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(chatSessions, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      // Copilot has written both `.json` and `.jsonl` here across versions.
      if (!entry.isFile() || !/\.jsonl?$/.test(entry.name)) {
        continue;
      }
      const file = path.join(chatSessions, entry.name);
      refreshFile(db, file, entry.name.replace(/\.jsonl?$/, ''));
    }
  }
}

/**
 * Titles from a workspace's `state.vscdb`, which is where VS Code actually
 * keeps the auto-generated and user-renamed session names. The per-session file
 * writes `customTitle: null` eagerly and rarely backfills it, so this is the
 * better source and takes precedence.
 *
 * The extension has to snapshot-copy each of these — 88 files, 159 MB here — to
 * read one row, because its SQLite driver refuses a WAL database. better-sqlite3
 * opens them read-only in place, so the cost is one query per changed file.
 */
function refreshStateDb(db: IndexDb, file: string): void {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return;
  }

  // Fingerprint under the file's own path so an unchanged store is skipped
  // wholesale, rather than re-read once per session it contains.
  const marker = `vscdb:${file}`;
  const known = db.getTitle(marker);
  if (known !== undefined && known.srcMtimeMs === mtimeMs) {
    return;
  }

  let store: Database.Database;
  try {
    store = new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    // Held exclusively, or WAL with no -shm to attach to. Try again next pass.
    return;
  }

  try {
    const row = store
      .prepare(`SELECT value FROM ItemTable WHERE key = 'chat.ChatSessionStore.index'`)
      .get() as { value: string | Buffer } | undefined;
    if (row !== undefined) {
      const json = typeof row.value === 'string' ? row.value : row.value.toString('utf8');
      for (const [sessionId, title] of parseChatSessionIndex(json)) {
        db.putTitle(sessionId, title, false, file, mtimeMs);
      }
    }
    // Record the store itself as seen, whether or not it held an index.
    db.putTitle(marker, undefined, false, file, mtimeMs);
  } catch {
    // A store without ItemTable is not one of ours; nothing to do.
  } finally {
    store.close();
  }
}

function refreshFile(db: IndexDb, file: string, sessionId: string): void {
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return;
  }

  const known = db.getTitle(sessionId);
  if (known !== undefined && known.srcPath === file && known.srcMtimeMs === mtimeMs) {
    return; // unchanged since it was last read
  }

  // The state.vscdb index is authoritative and must not be downgraded by a
  // per-session file — whose `customTitle` is usually null, leaving only the
  // first-request fallback. Core enforces this by applying the index last; here
  // the passes are incremental, so the rule has to be explicit.
  if (known !== undefined && known.title !== undefined && isStateDb(known.srcPath)) {
    return;
  }

  const head = readHead(file);
  if (head === undefined) {
    return;
  }
  const info = parseSessionTitle(head);
  db.putTitle(sessionId, info?.title, info?.derived === true, file, mtimeMs);
}

function isStateDb(srcPath: string): boolean {
  return srcPath.endsWith('state.vscdb');
}

/** Read at most {@link HEAD_BYTES} from the start of a file. */
function readHead(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = fs.readSync(fd, buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Nothing useful to do if the handle will not close.
      }
    }
  }
}
