import type { Database } from 'node-sqlite3-wasm';
import { sanitizeRepositoryUrl, UNKNOWN_REPOSITORY } from './repositoryUrl';

/**
 * Per-session repository resolution.
 *
 * `copilot_chat.repo.remote_url` is SPARSE — it appears on a handful of
 * `invoke_agent` spans, not on every span. Resolving per span would mislabel
 * most activity as `unknown`. Instead we build a
 * `Map<sessionKey, sanitizedRepository>` from the sparse attribute, keyed by
 * `COALESCE(conversation_id, chat_session_id)` (identical to the `sessions`
 * view and the cloud join key), then back-fill it onto every span/session.
 *
 * `MAX(value)` plays the role of KQL `take_any` (one stable raw URL per
 * session). The raw URL is sanitized HERE (mandatory) before it is exposed, so
 * no credential-bearing remote ever reaches a model or an aggregate.
 */

interface RepoRow {
  session_id: string | null;
  repo_url_raw: string | null;
}

/**
 * SQL building the sparse `(session_id → raw repo url)` lookup. Kept module-
 * level so it is shared/testable. Note: the value selected here is STILL RAW;
 * sanitization happens in {@link buildRepositoryResolver}.
 */
const REPO_BY_SESSION_SQL = `
  SELECT COALESCE(s.conversation_id, s.chat_session_id) AS session_id,
         MAX(a.value) AS repo_url_raw
  FROM spans s
  JOIN span_attributes a
    ON a.span_id = s.span_id
   AND a.key = 'copilot_chat.repo.remote_url'
  WHERE a.value IS NOT NULL AND a.value <> ''
    AND COALESCE(s.conversation_id, s.chat_session_id) IS NOT NULL
  GROUP BY COALESCE(s.conversation_id, s.chat_session_id)
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
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.session_id === null) {
        continue;
      }
      // Sanitize the raw URL — privacy-critical chokepoint.
      map.set(row.session_id, sanitizeRepositoryUrl(row.repo_url_raw));
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
