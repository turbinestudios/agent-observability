import {
  SessionTitleInfo,
  readSessionTitles,
  workspaceStorageDirFor,
} from './sessionTitles';
import { readChatSessionIndexTitles } from './chatSessionIndex';

/**
 * LOCAL-ONLY merged session-title resolution over one or more VS Code
 * `workspaceStorage` directories, shared by the read layer
 * ({@link ./telemetryService.TelemetryService}).
 *
 * Titles live in two per-workspace stores (see {@link ./chatSessionIndex} and
 * {@link ./sessionTitles}); this module locates those stores from candidate
 * native DB paths and merges both readers with one precedence rule:
 *
 *   `state.vscdb` index title (authoritative, non-derived)
 *     > JSONL `customTitle` (non-derived)
 *     > first-request fallback (derived)
 *
 * PRIVACY: a session title is model-/user-derived raw content (same class as
 * `copilot_chat.user_request`). Titles are read for the LOCAL Sessions view
 * and the LOCAL archive sidecar ONLY — never logged, never placed on the
 * aggregate/sync path.
 */

/**
 * The unique `workspaceStorage` directories siblings of the given source DB
 * paths. Paths outside the native `github.copilot-chat` layout (the durable
 * archive, the live-ingest DB, test fixtures) contribute nothing — they have
 * no title store beside them.
 */
export function titleStorageDirs(sourcePaths: Iterable<string>): string[] {
  const dirs = new Set<string>();
  for (const sourcePath of sourcePaths) {
    const dir = workspaceStorageDirFor(sourcePath);
    if (dir !== undefined) {
      dirs.add(dir);
    }
  }
  return [...dirs];
}

/**
 * Overlay `info` onto `titles[id]` unless that would DOWNGRADE an
 * authoritative (non-derived) title to a derived fallback. On equal
 * derivedness the incoming title wins, so fresher layers applied later
 * override staler ones (e.g. live stores over archived titles).
 */
export function overlayTitle(
  titles: Map<string, SessionTitleInfo>,
  id: string,
  info: SessionTitleInfo,
): void {
  const existing = titles.get(id);
  if (existing === undefined || existing.derived || !info.derived) {
    titles.set(id, info);
  }
}

/**
 * Read and merge every title store under the given `workspaceStorage`
 * directories into one `Map<sessionId, SessionTitleInfo>`. A session lives in
 * exactly one VS Code edition, so cross-directory id clashes are rare; when
 * they happen the standard precedence applies and the index title wins.
 */
export function readMergedSessionTitles(
  dirs: readonly string[],
): Map<string, SessionTitleInfo> {
  const titles = new Map<string, SessionTitleInfo>();
  for (const dir of dirs) {
    for (const [id, info] of readSessionTitles(dir)) {
      overlayTitle(titles, id, info);
    }
  }
  // The state.vscdb index is authoritative (always non-derived) — applied
  // last so it wins over any JSONL-sourced title.
  for (const dir of dirs) {
    for (const [id, title] of readChatSessionIndexTitles(dir)) {
      titles.set(id, { title, derived: false });
    }
  }
  return titles;
}
