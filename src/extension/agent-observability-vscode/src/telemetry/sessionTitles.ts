import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * LOCAL-ONLY reader for the human-readable names GitHub Copilot assigns to chat
 * sessions, used to label rows in the Sessions tree.
 *
 * Copilot persists each chat session as an append-only JSONL log at
 * `User/workspaceStorage/<workspaceHash>/chatSessions/<sessionId>.jsonl`, a
 * sibling of the `User/globalStorage/github.copilot-chat/agent-traces.db`
 * telemetry source. The **filename is the session id** — the same UUID the
 * telemetry DB stores as `chat_session_id` / `conversation_id` — so titles join
 * to {@link ./models.SessionSummary} by id with no extra correlation.
 *
 * File shape (one JSON object per line, `{ kind, v }`):
 * - `kind: 0` — the full session snapshot. `v.customTitle` holds the session
 *   name (Copilot's auto-generated title OR a manual rename — there is no flag
 *   distinguishing the two). `v.requests` is the request history.
 * - `kind: 2` — appended request(s); `v` is an array of request objects.
 * - `kind: 1` — other field updates (e.g. model selection); never a title.
 *
 * Active sessions write the snapshot early with `customTitle: null` and an empty
 * `requests`, baking the title in only when the session is closed/reloaded. For
 * those we fall back to the first user request's text — exactly what VS Code's
 * own history list shows until a title is generated.
 *
 * PRIVACY: `customTitle` and request text are model-/user-derived raw content
 * (same class as `copilot_chat.user_request`). They are read here for the LOCAL
 * Sessions view ONLY — never logged, never placed on the aggregate/sync path.
 * `SessionSummary` is not consumed by the aggregator, and the title field added
 * there must never be threaded into an aggregate batch.
 */

/** A resolved session name plus how it was obtained. */
export interface SessionTitleInfo {
  /** The display title. */
  title: string;
  /**
   * `false` when taken from `customTitle` (Copilot's auto-generated name or a
   * user rename); `true` when derived from the first request's text because no
   * `customTitle` was persisted yet (active session).
   */
  derived: boolean;
}

/** Max length of a derived (first-request) title before truncation. */
const DERIVED_TITLE_MAX = 60;

/**
 * Derive the `workspaceStorage` directory that sits beside a resolved
 * `agent-traces.db` path, or `undefined` when the path is not the expected
 * `.../User/globalStorage/github.copilot-chat/agent-traces.db` layout (e.g. a
 * test fixture or a custom `sqlitePath` override pointing elsewhere). Returning
 * `undefined` there means "no titles available", which the caller treats as a
 * graceful no-op rather than scanning an unrelated directory.
 */
export function workspaceStorageDirFor(dbPath: string): string | undefined {
  const copilotDir = path.dirname(dbPath); // .../globalStorage/github.copilot-chat
  if (path.basename(copilotDir) !== 'github.copilot-chat') {
    return undefined;
  }
  const globalStorageDir = path.dirname(copilotDir); // .../globalStorage
  if (path.basename(globalStorageDir) !== 'globalStorage') {
    return undefined;
  }
  const userDir = path.dirname(globalStorageDir); // .../User
  return path.join(userDir, 'workspaceStorage');
}

/**
 * Scan every `workspaceStorage/<hash>/chatSessions/*.jsonl` file and build a
 * `Map<sessionId, SessionTitleInfo>`. Resilient by design: a missing directory,
 * an unreadable file, or a malformed line is skipped, never thrown — a partial
 * map is always better than failing the whole Sessions view.
 *
 * The telemetry DB is global across workspaces, so all workspace hashes are
 * scanned. When the same session id appears in more than one location, a real
 * `customTitle` (`derived: false`) is preferred over a derived fallback.
 */
export function readSessionTitles(workspaceStorageDir: string): Map<string, SessionTitleInfo> {
  const titles = new Map<string, SessionTitleInfo>();

  let workspaceHashes: string[];
  try {
    workspaceHashes = fs.readdirSync(workspaceStorageDir);
  } catch {
    return titles; // directory absent / unreadable
  }

  for (const hash of workspaceHashes) {
    const chatSessionsDir = path.join(workspaceStorageDir, hash, 'chatSessions');
    let files: string[];
    try {
      files = fs.readdirSync(chatSessionsDir);
    } catch {
      continue; // no chatSessions for this workspace
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl') && !file.endsWith('.json')) {
        continue;
      }
      const sessionId = file.replace(/\.jsonl?$/, '');
      let content: string;
      try {
        content = fs.readFileSync(path.join(chatSessionsDir, file), 'utf8');
      } catch {
        continue; // unreadable file
      }
      const info = parseSessionTitle(content);
      if (info === undefined) {
        continue;
      }
      const existing = titles.get(sessionId);
      // Prefer a real customTitle over a derived fallback; otherwise last wins.
      if (existing === undefined || (existing.derived && !info.derived)) {
        titles.set(sessionId, info);
      }
    }
  }

  return titles;
}

/**
 * Extract a {@link SessionTitleInfo} from one chat-session JSONL file's content,
 * or `undefined` when no title can be determined. Pure (no I/O) so it is unit
 * testable on a string. Parses only the line-0 snapshot for the common case
 * (a persisted `customTitle`); scans later request deltas only for the
 * active-session fallback.
 */
export function parseSessionTitle(content: string): SessionTitleInfo | undefined {
  const lines = content.split('\n');

  const snapshot = parseSnapshot(lines);
  if (snapshot === undefined) {
    return undefined;
  }

  const custom = nonEmptyString(snapshot.customTitle);
  if (custom !== undefined) {
    return { title: custom, derived: false };
  }

  // No persisted title — fall back to the first user request's text, which may
  // live in the snapshot's `requests` or in a later `kind: 2` request delta.
  const requestText = firstRequestText(snapshot, lines);
  if (requestText === undefined) {
    return undefined;
  }
  return { title: truncate(requestText, DERIVED_TITLE_MAX), derived: true };
}

/** The `v` payload of the first non-empty (kind-0 snapshot) line, if parseable. */
function parseSnapshot(lines: string[]): Record<string, unknown> | undefined {
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    const v = payloadOf(trimmed);
    return v !== undefined && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  }
  return undefined;
}

/** First request message text from the snapshot, else from a `kind: 2` delta. */
function firstRequestText(
  snapshot: Record<string, unknown>,
  lines: string[],
): string | undefined {
  const fromSnapshot = textOfFirstRequest(snapshot.requests);
  if (fromSnapshot !== undefined) {
    return fromSnapshot;
  }
  // Snapshot had no requests (active session): scan delta lines for the first
  // appended request list (`kind: 2`, `v` is an array of request objects).
  let first = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (first) {
      first = false; // skip the snapshot line already inspected above
      continue;
    }
    const v = payloadOf(trimmed);
    if (Array.isArray(v)) {
      const text = textOfFirstRequest(v);
      if (text !== undefined) {
        return text;
      }
    }
  }
  return undefined;
}

/** The `message.text` of the first request in an array, when present. */
function textOfFirstRequest(requests: unknown): string | undefined {
  if (!Array.isArray(requests) || requests.length === 0) {
    return undefined;
  }
  const message = (requests[0] as { message?: unknown }).message;
  if (message !== null && typeof message === 'object') {
    return nonEmptyString((message as { text?: unknown }).text);
  }
  return undefined;
}

/** Parse one JSONL line and return its `v` payload (or the object itself). */
function payloadOf(line: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (parsed !== null && typeof parsed === 'object' && 'v' in parsed) {
    return (parsed as { v: unknown }).v;
  }
  return parsed;
}

/** A trimmed non-empty string, else `undefined`. */
function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Collapse internal whitespace and truncate with an ellipsis. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}
