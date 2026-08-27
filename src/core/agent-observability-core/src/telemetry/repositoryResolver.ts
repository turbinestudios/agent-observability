import type { Database } from 'node-sqlite3-wasm';
import { sanitizeRepositorySlug, sanitizeRepositoryUrl, UNKNOWN_REPOSITORY } from './repositoryUrl';

/**
 * Per-session repository resolution.
 *
 * The repo attribute is SPARSE — it appears on a handful of `invoke_agent`
 * spans, not on every span. Resolving per span would mislabel most activity as
 * `unknown`. Instead we build a `Map<sessionKey, sanitizedRepository>` from the
 * sparse attribute, keyed by `COALESCE(conversation_id, chat_session_id)`
 * (identical to the `sessions` view and the cloud join key), then back-fill it
 * onto every span/session.
 *
 * TWO attribute spellings are read, because the emitters differ:
 * - `copilot_chat.repo.remote_url` — VS Code Copilot Chat: a full git remote.
 * - `github.copilot.git.repository` — autonomous Copilot CLI agents: a bare
 *   `owner/repo` slug. Without this, every relayed autonomous session resolved
 *   to `unknown` and vanished from the Sessions tree for anyone excluding the
 *   `unknown` bucket.
 * The full remote wins when a session recorded both.
 *
 * When a session recorded MORE THAN ONE distinct value for a key — the
 * workspace's `origin` remote was re-pointed mid-session — the value of the
 * MOST RECENT repo-bearing span wins, matching where the work ended up. (The
 * previous `MAX(value)` pick was alphabetical and could resolve such a session
 * to the long-abandoned remote.) The raw value is sanitized HERE (mandatory)
 * before it is exposed, so no credential-bearing remote ever reaches a model
 * or an aggregate.
 */

interface RepoRow {
  session_id: string | null;
  key: string;
  value: string;
  start_time_ms: number | null;
}

/**
 * SQL listing every sparse repo-attribute span `(session_id, key, raw value,
 * span start)`. Kept module-level so it is shared/testable. Note: the values
 * selected here are STILL RAW; the per-session latest-wins fold and the
 * sanitization happen in {@link RepositoryResolver.fromDatabase}.
 */
const REPO_BY_SESSION_SQL = `
  SELECT COALESCE(s.conversation_id, s.chat_session_id) AS session_id,
         a.key AS key,
         a.value AS value,
         s.start_time_ms AS start_time_ms
  FROM spans s
  JOIN span_attributes a
    ON a.span_id = s.span_id
   AND a.key IN ('copilot_chat.repo.remote_url', 'github.copilot.git.repository')
  WHERE a.value IS NOT NULL AND a.value <> ''
    AND COALESCE(s.conversation_id, s.chat_session_id) IS NOT NULL
`;

/**
 * Maps a session key to its sanitized repository, defaulting any unmapped
 * session to `unknown`.
 */
export class RepositoryResolver {
  private readonly map: ReadonlyMap<string, string>;
  /**
   * Optional SCOPED fallback consulted only when a session recorded no
   * `repo.remote_url` of its own. Lets a just-started session — whose repo
   * attribute lands late, on an `invoke_agent` span 7-33s in — group under the
   * current workspace's repository immediately, instead of sitting in the
   * `unknown` bucket until then. The fallback must be scoped (e.g. to the
   * current workspace's chat-session ids) so it never mislabels an unrelated
   * session; it returns `undefined` for any session it does not own.
   */
  private fallback?: (sessionId: string) => string | undefined;

  private constructor(map: ReadonlyMap<string, string>) {
    this.map = map;
  }

  /**
   * Install (or clear with `undefined`) the scoped repository fallback. Applied
   * on top of the sparse attribute map — a session that DID record its own
   * remote always keeps that value; the fallback only fills genuine gaps.
   */
  setFallback(fallback: ((sessionId: string) => string | undefined) | undefined): void {
    this.fallback = fallback;
  }

  /** Build the resolver by reading the sparse repo attributes from `db`. */
  static fromDatabase(db: Database): RepositoryResolver {
    const rows = db.all(REPO_BY_SESSION_SQL) as unknown as RepoRow[];
    // Per session, keep each key's value from the LATEST repo-bearing span, so
    // a mid-session `origin` re-point resolves to where the work ended up.
    const latest = new Map<
      string,
      { url?: { value: string; atMs: number }; slug?: { value: string; atMs: number } }
    >();
    for (const row of rows) {
      if (row.session_id === null) {
        continue;
      }
      let entry = latest.get(row.session_id);
      if (entry === undefined) {
        entry = {};
        latest.set(row.session_id, entry);
      }
      const atMs = row.start_time_ms ?? 0;
      const slot = row.key === 'copilot_chat.repo.remote_url' ? 'url' : 'slug';
      const current = entry[slot];
      if (current === undefined || atMs >= current.atMs) {
        entry[slot] = { value: row.value, atMs };
      }
    }

    const map = new Map<string, string>();
    for (const [sessionId, entry] of latest) {
      // Sanitize the raw values — privacy-critical chokepoint. A full remote
      // (Copilot Chat) wins; the bare `owner/repo` slug an autonomous Copilot
      // CLI agent reports is the fallback.
      const fromUrl = sanitizeRepositoryUrl(entry.url?.value);
      map.set(
        sessionId,
        fromUrl !== UNKNOWN_REPOSITORY ? fromUrl : sanitizeRepositorySlug(entry.slug?.value),
      );
    }
    return new RepositoryResolver(map);
  }

  /** Construct directly from a prebuilt map (testing seam). */
  static fromMap(map: ReadonlyMap<string, string>): RepositoryResolver {
    return new RepositoryResolver(map);
  }

  /**
   * Resolve a session key to its sanitized repository. Returns `unknown` when
   * the session never recorded a remote URL (or the key is null/empty), unless
   * a scoped {@link setFallback} claims the session — then its (already
   * sanitized) repository is used.
   */
  resolve(sessionId: string | null | undefined): string {
    if (sessionId === null || sessionId === undefined || sessionId.length === 0) {
      return UNKNOWN_REPOSITORY;
    }
    const mapped = this.map.get(sessionId);
    if (mapped !== undefined) {
      return mapped;
    }
    const fallback = this.fallback?.(sessionId);
    if (fallback !== undefined && fallback.length > 0 && fallback !== UNKNOWN_REPOSITORY) {
      return fallback;
    }
    return UNKNOWN_REPOSITORY;
  }
}
