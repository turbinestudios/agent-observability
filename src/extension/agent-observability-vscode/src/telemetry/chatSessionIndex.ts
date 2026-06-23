import * as path from 'node:path';
import * as fs from 'node:fs';
import { Database } from 'node-sqlite3-wasm';
import { createReadonlySnapshot } from './snapshot';

/**
 * LOCAL-ONLY reader for the human-readable names GitHub Copilot / VS Code assign
 * to chat sessions — the PRIMARY title source, ahead of the per-session JSONL's
 * `customTitle` (see {@link ./sessionTitles}).
 *
 * The auto-generated (and user-renamed) session title is persisted NOT in the
 * `chatSessions/<id>.jsonl` log — whose `customTitle` is written `null` eagerly
 * and, in practice, almost never backfilled — but in each workspace's
 * `User/workspaceStorage/<hash>/state.vscdb`, a key/value SQLite store. The row
 * `ItemTable['chat.ChatSessionStore.index']` holds JSON of the shape:
 *
 *   { "version": 1, "entries": { "<sessionId>": { "title": "...", ... }, ... } }
 *
 * Entry keys are the chat-session id, sometimes prefixed by the chat source
 * (`claude-code:/<uuid>`, `copilotcli:/<uuid>`, …) and otherwise a bare UUID for
 * Copilot's own chat. We extract the UUID from the key and join it to telemetry
 * by `chat_session_id` (the bare UUID Copilot stores). The index is a rolling,
 * recent-only window; the JSONL store reaches further back, so this is layered
 * OVER {@link ./sessionTitles}, not a replacement.
 *
 * `state.vscdb` runs in WAL mode and is held open by VS Code, so — exactly like
 * `agent-traces.db` — we read it through a read-only snapshot copy
 * ({@link createReadonlySnapshot}) rather than touching the live file.
 *
 * PRIVACY: a session `title` is model-/user-derived raw content (same class as
 * `copilot_chat.user_request`). It is read here for the LOCAL Sessions view
 * ONLY — never logged, never placed on the aggregate/sync path.
 */

/** The `ItemTable` key whose JSON value holds the chat-session index. */
const INDEX_KEY = 'chat.ChatSessionStore.index';

/**
 * Matches a UUID anywhere in a string (no `g` flag, so `.exec` is stateless).
 * Used to pull the chat-session id out of an index key that may be prefixed,
 * e.g. `claude-code:/<uuid>` or a bare `<uuid>`.
 */
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Parse the `chat.ChatSessionStore.index` JSON value into a `Map<uuid, title>`.
 * Pure (no I/O) so it is unit testable on a string. Resilient: malformed JSON,
 * a missing `entries` object, a non-string/blank `title`, or a key with no UUID
 * are each skipped — never thrown.
 *
 * Entries flagged `isEmpty` are skipped: a not-yet-started session carries the
 * generic placeholder title (e.g. "New Chat"), which would otherwise OVERRIDE
 * the more informative first-request fallback from {@link ./sessionTitles}.
 */
export function parseChatSessionIndex(json: string): Map<string, string> {
  const titles = new Map<string, string>();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return titles;
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (entries === null || typeof entries !== 'object') {
    return titles;
  }

  for (const [key, entry] of Object.entries(entries as Record<string, unknown>)) {
    if (entry === null || typeof entry !== 'object') {
      continue;
    }
    // An unstarted session has only the placeholder title; skip it so the
    // first-request fallback wins instead.
    if ((entry as { isEmpty?: unknown }).isEmpty === true) {
      continue;
    }
    const rawTitle = (entry as { title?: unknown }).title;
    if (typeof rawTitle !== 'string') {
      continue;
    }
    const title = rawTitle.trim();
    if (title.length === 0) {
      continue;
    }
    const match = UUID_RE.exec(key);
    if (match === null) {
      continue;
    }
    const id = match[0].toLowerCase();
    // The index carries one entry per id; keep the first non-empty title.
    if (!titles.has(id)) {
      titles.set(id, title);
    }
  }

  return titles;
}

/**
 * Scan every `workspaceStorage/<hash>/state.vscdb` and merge their chat-session
 * indexes into one `Map<uuid, title>`. Resilient by design: a missing
 * directory, an unreadable/locked DB, or a malformed value is skipped, never
 * thrown — a partial map is always better than failing the Sessions view.
 *
 * Every workspace hash with a `state.vscdb` is read — earlier versions gated on
 * a sibling `chatSessions/` directory, but that caused ungrouped (repo-less)
 * sessions to miss their auto-generated titles when the JSONL store was absent.
 * `readIndexValue` already returns `undefined` quickly for missing/unreadable
 * files, so the broader scan is safe. When the same id appears in more than one
 * workspace, the first non-empty title wins.
 */
export function readChatSessionIndexTitles(workspaceStorageDir: string): Map<string, string> {
  const titles = new Map<string, string>();

  let hashes: string[];
  try {
    hashes = fs.readdirSync(workspaceStorageDir);
  } catch {
    return titles; // directory absent / unreadable
  }

  for (const hash of hashes) {
    const value = readIndexValue(path.join(workspaceStorageDir, hash, 'state.vscdb'));
    if (value === undefined) {
      continue;
    }
    for (const [id, title] of parseChatSessionIndex(value)) {
      if (!titles.has(id)) {
        titles.set(id, title);
      }
    }
  }

  return titles;
}

/**
 * Read the raw `chat.ChatSessionStore.index` value from one `state.vscdb`, or
 * `undefined` on any failure. Goes through {@link createReadonlySnapshot} (copy
 * + journal normalize) because the bundled node-sqlite3-wasm driver cannot open
 * a WAL-mode file, and VS Code keeps `state.vscdb` in WAL mode while running.
 * The snapshot is always disposed; the original file is never opened.
 */
function readIndexValue(dbPath: string): string | undefined {
  if (!fs.existsSync(dbPath)) {
    return undefined;
  }

  let snapshot;
  try {
    snapshot = createReadonlySnapshot(dbPath);
  } catch {
    return undefined; // missing / unreadable / un-normalizable
  }

  let db: Database | undefined;
  try {
    db = new Database(snapshot.dbPath, { readOnly: true, fileMustExist: true });
    const row = db.get('SELECT value FROM ItemTable WHERE key = ?', [INDEX_KEY]);
    const value = (row as { value?: unknown } | null)?.value;
    if (typeof value === 'string') {
      return value;
    }
    // VS Code may store the value as a BLOB; decode it as UTF-8 JSON.
    if (value instanceof Uint8Array) {
      return Buffer.from(value).toString('utf8');
    }
    return undefined;
  } catch {
    return undefined; // not the expected schema / open failure
  } finally {
    if (db !== undefined) {
      try {
        db.close();
      } catch {
        // already closed / never opened — ignore
      }
    }
    snapshot.dispose();
  }
}
