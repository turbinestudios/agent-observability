import * as fs from 'node:fs';
import * as path from 'node:path';
import { SessionTitleInfo, parseSessionTitle } from './sessionTitles';

/**
 * LOCAL-ONLY reader over the CURRENT workspace's Copilot chat-session store,
 * used to surface a session in the Sessions view as early as possible.
 *
 * A chat session is persisted as `User/workspaceStorage/<hash>/chatSessions/
 * <sessionId>.jsonl` the moment it is opened — typically BEFORE its first
 * telemetry span is exported. Enumerating this one workspace's `chatSessions`
 * directory therefore yields:
 *
 * - {@link WorkspaceStoreResult.sessionIds}: EVERY chat-session UUID that
 *   belongs to this workspace, used to SCOPE the repository fallback (see
 *   {@link ./repositoryResolver.RepositoryResolver.setFallback}) so a
 *   just-started session groups under the workspace's repo before its own
 *   `repo.remote_url` span lands — and never mislabels a session from another
 *   workspace.
 * - {@link WorkspaceStoreResult.recent}: the RECENT, titled sessions used to
 *   synthesize a placeholder list row for a session that has no telemetry span
 *   yet at all. Bounded by a recency window + a hard cap so the list can never
 *   be flooded with historical, long-dead chats.
 *
 * The `<hash>` directory is the current window's own workspace storage — derived
 * from `ExtensionContext.storageUri` — so the scan is inherently limited to this
 * workspace and stays cheap (filenames + mtimes; file contents are read only for
 * the few recent sessions).
 *
 * PRIVACY: a session title / first-request text is model-/user-derived raw
 * content (same class as `copilot_chat.user_request`). It is read here for the
 * LOCAL Sessions view ONLY — never logged, never placed on the aggregate/sync
 * path. The synthesized {@link ./models.SessionSummary} rows carry a `title`
 * that, like every other title, must never be threaded into an aggregate batch.
 */

/** Matches a `chatSessions` filename that is a bare UUID (Copilot's own chat). */
const UUID_FILE_RE =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl?$/i;

/** Default recency window for synthesizing a spanless session: 30 minutes. */
const DEFAULT_RECENCY_MS = 30 * 60 * 1000;

/** Default hard cap on synthesized (spanless) rows, guarding against a flood. */
const DEFAULT_MAX_RECENT = 20;

/** A recent, spanless chat session discovered from the workspace store. */
export interface WorkspaceStoreSession {
  /** The lowercased chat-session UUID (joins telemetry by `chat_session_id`). */
  sessionId: string;
  /** Best-effort session start (the JSONL file's mtime). */
  startedAtMs: number;
  /** Display title (from `customTitle`, else the first request's text). */
  title: string;
  /** `true` when derived from the first request because no `customTitle` yet. */
  titleDerived: boolean;
}

/** The current workspace's chat-session store, read for the Sessions view. */
export interface WorkspaceStoreResult {
  /** Every chat-session UUID in this workspace (repo-fallback scoping set). */
  sessionIds: ReadonlySet<string>;
  /** Recent, titled sessions eligible for spanless synthesis (newest first). */
  recent: WorkspaceStoreSession[];
}

/** Filesystem seam so the reader is unit-testable without touching disk. */
export interface WorkspaceStoreIo {
  /** `chatSessions` filenames, or `[]` when the directory is absent/unreadable. */
  listChatSessionFiles(chatSessionsDir: string): string[];
  /** A file's mtime in epoch ms, or `undefined` when unreadable. */
  statMtimeMs(filePath: string): number | undefined;
  /** A file's UTF-8 contents, or `undefined` when unreadable. */
  readFile(filePath: string): string | undefined;
}

/** Options for {@link readWorkspaceStoreSessions}. */
export interface WorkspaceStoreOptions {
  io?: WorkspaceStoreIo;
  /** "Now" in epoch ms (injectable for tests). Defaults to `Date.now()`. */
  nowMs?: number;
  /** Recency window for synthesis. Defaults to 30 minutes. */
  recencyMs?: number;
  /** Hard cap on synthesized rows. Defaults to 20. */
  maxRecent?: number;
}

const defaultIo: WorkspaceStoreIo = {
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
 * Read the current workspace's chat-session store from its `<hash>` storage
 * directory. Resilient by design: a missing directory or an unreadable file is
 * skipped, never thrown — a partial result is always better than failing the
 * Sessions view.
 */
export function readWorkspaceStoreSessions(
  hashDir: string,
  options: WorkspaceStoreOptions = {},
): WorkspaceStoreResult {
  const io = options.io ?? defaultIo;
  const nowMs = options.nowMs ?? Date.now();
  const recencyMs = options.recencyMs ?? DEFAULT_RECENCY_MS;
  const maxRecent = options.maxRecent ?? DEFAULT_MAX_RECENT;
  const cutoffMs = nowMs - recencyMs;

  const chatSessionsDir = path.join(hashDir, 'chatSessions');
  const sessionIds = new Set<string>();
  const recent: WorkspaceStoreSession[] = [];

  for (const file of io.listChatSessionFiles(chatSessionsDir)) {
    const match = UUID_FILE_RE.exec(file);
    if (match === null) {
      continue;
    }
    const sessionId = match[1].toLowerCase();
    sessionIds.add(sessionId);

    // Only recent files are candidates for spanless synthesis — an old chat is
    // either already in telemetry or genuinely dead, and must not resurface.
    const filePath = path.join(chatSessionsDir, file);
    const mtimeMs = io.statMtimeMs(filePath);
    if (mtimeMs === undefined || mtimeMs < cutoffMs) {
      continue;
    }
    const content = io.readFile(filePath);
    if (content === undefined) {
      continue;
    }
    const info: SessionTitleInfo | undefined = parseSessionTitle(content);
    if (info === undefined) {
      continue; // no title AND no first request yet — an empty placeholder chat
    }
    recent.push({
      sessionId,
      startedAtMs: mtimeMs,
      title: info.title,
      titleDerived: info.derived,
    });
  }

  recent.sort((a, b) => b.startedAtMs - a.startedAtMs);
  return { sessionIds, recent: recent.slice(0, maxRecent) };
}
