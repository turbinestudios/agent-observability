import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { ListSessionsParams, SessionGroup, SessionRow } from '../../shared/rpc';

/**
 * The persisted session index — the reason the desktop list paints instantly.
 *
 * The extension builds its session list by reading and parsing every recent
 * transcript on each refresh, which costs hundreds of megabytes of I/O before
 * the first row appears. Here that work happens once, in the background, and
 * the interactive path is a single indexed SELECT.
 *
 * This is a CACHE, never a source of truth: every row can be rederived from the
 * files on disk. That is what lets a schema change or a corrupted tail-parse be
 * resolved by deleting the database and rebuilding, and why a version mismatch
 * drops the tables rather than attempting a migration.
 *
 * WAL mode matters beyond speed: the indexer worker writes while the query
 * connection reads, concurrently, without either blocking the UI.
 */

/** Bump to invalidate every existing index (drop-and-rebuild, no migration). */
export const SCHEMA_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- One row per physical file we fingerprint, carrying the resume state that
-- makes an append cost only the appended bytes.
CREATE TABLE IF NOT EXISTS files (
  path         TEXT PRIMARY KEY,
  source       TEXT NOT NULL,
  session_id   TEXT,
  kind         TEXT NOT NULL,
  size         INTEGER NOT NULL,
  mtime_ms     REAL NOT NULL,
  -- Hash of the first bytes. A file rewritten in place can keep its size and
  -- mtime resolution, so this is what makes resuming from an offset safe.
  head_hash    TEXT,
  -- Byte offset of the end of the last COMPLETE line parsed so far.
  parsed_bytes INTEGER NOT NULL DEFAULT 0,
  -- Serialized summary accumulator, so a tail parse resumes mid-session.
  acc_state    TEXT
);
CREATE INDEX IF NOT EXISTS idx_files_session ON files (source, session_id);

CREATE TABLE IF NOT EXISTS sessions (
  source            TEXT NOT NULL,
  session_id        TEXT NOT NULL,
  repository        TEXT NOT NULL DEFAULT 'unknown',
  title             TEXT,
  title_derived     INTEGER NOT NULL DEFAULT 0,
  started_at_ms     INTEGER NOT NULL DEFAULT 0,
  ended_at_ms       INTEGER NOT NULL DEFAULT 0,
  duration_ms       INTEGER NOT NULL DEFAULT 0,
  interaction_count INTEGER NOT NULL DEFAULT 0,
  llm_calls         INTEGER NOT NULL DEFAULT 0,
  tool_calls        INTEGER NOT NULL DEFAULT 0,
  input_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens     INTEGER NOT NULL DEFAULT 0,
  cached_tokens     INTEGER NOT NULL DEFAULT 0,
  model             TEXT NOT NULL DEFAULT 'unknown',
  agent_modes       TEXT NOT NULL DEFAULT '[]',
  state_label       TEXT,
  external_url      TEXT,
  cost_micros       INTEGER,
  main_path         TEXT,
  -- 1 while the row is a discovery placeholder with unparsed counts.
  pending           INTEGER NOT NULL DEFAULT 0,
  indexed_at_ms     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_recent ON sessions (ended_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_repo ON sessions (source, repository, ended_at_ms DESC);

-- Copilot titles, so the multi-gigabyte chat-session scan happens once per
-- changed file instead of on every refresh.
CREATE TABLE IF NOT EXISTS titles (
  session_id   TEXT PRIMARY KEY,
  title        TEXT,
  derived      INTEGER NOT NULL DEFAULT 0,
  src_path     TEXT NOT NULL,
  src_mtime_ms REAL NOT NULL
);

-- Resolving a git remote means walking up to a .git/config; cache it per cwd.
CREATE TABLE IF NOT EXISTS repo_cache (
  cwd            TEXT PRIMARY KEY,
  repository     TEXT NOT NULL,
  resolved_at_ms INTEGER NOT NULL
);
`;

/** Row shape as stored; mapped to {@link SessionRow} on read. */
export interface StoredSession {
  source: string;
  session_id: string;
  repository: string;
  title: string | null;
  title_derived: number;
  started_at_ms: number;
  ended_at_ms: number;
  duration_ms: number;
  interaction_count: number;
  llm_calls: number;
  tool_calls: number;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  model: string;
  agent_modes: string;
  state_label: string | null;
  external_url: string | null;
  cost_micros: number | null;
  main_path: string | null;
  pending: number;
  indexed_at_ms: number;
}

/** Per-file fingerprint plus the resume state for incremental parsing. */
export interface FileState {
  path: string;
  source: string;
  sessionId: string | null;
  kind: string;
  size: number;
  mtimeMs: number;
  headHash: string | null;
  parsedBytes: number;
  accState: string | null;
}

/** Where the index lives. Home-anchored so it survives app reinstalls. */
export function resolveIndexDbPath(): string {
  const dir = path.join(os.homedir(), '.agent-observability', 'desktop');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'index.db');
}

export class IndexDb {
  private readonly db: Database.Database;

  constructor(file: string = resolveIndexDbPath()) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    // NORMAL is the right durability trade for a rebuildable cache: it survives
    // process crashes, and the worst a power loss costs is a re-index.
    this.db.pragma('synchronous = NORMAL');
    this.db.exec(SCHEMA);
    this.ensureVersion();
  }

  /**
   * Drop everything when the schema version moved. The index holds nothing that
   * cannot be rebuilt from disk, so recreating it is always cheaper and safer
   * than migrating it.
   */
  private ensureVersion(): void {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as
      | { value: string }
      | undefined;
    const found = row === undefined ? undefined : Number(row.value);
    if (found === SCHEMA_VERSION) {
      return;
    }
    if (found !== undefined) {
      this.db.exec('DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS titles; DROP TABLE IF EXISTS repo_cache;');
      this.db.exec(SCHEMA);
    }
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(SCHEMA_VERSION));
  }

  /** Erase all indexed data, keeping the schema. Backs the rebuild command. */
  clear(): void {
    this.db.exec('DELETE FROM files; DELETE FROM sessions; DELETE FROM titles; DELETE FROM repo_cache;');
  }

  close(): void {
    this.db.close();
  }

  // -- reads ----------------------------------------------------------------

  listSessions(params: ListSessionsParams): SessionRow[] {
    const { where, args } = buildFilter(params);
    const limit = clampLimit(params.limit);
    const offset = Math.max(0, params.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions ${where} ORDER BY ended_at_ms DESC, session_id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as StoredSession[];
    return rows.map(toSessionRow);
  }

  countSessions(params: ListSessionsParams): number {
    const { where, args } = buildFilter(params);
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM sessions ${where}`).get(...args) as {
      n: number;
    };
    return row.n;
  }

  listGroups(): SessionGroup[] {
    return this.db
      .prepare(
        `SELECT source, repository, COUNT(*) AS count, MAX(ended_at_ms) AS newestMs
         FROM sessions GROUP BY source, repository ORDER BY newestMs DESC`,
      )
      .all() as SessionGroup[];
  }

  /** Counts for the progress indicator: total rows and how many are hydrated. */
  counts(): { total: number; indexed: number } {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN pending = 0 THEN 1 ELSE 0 END) AS indexed FROM sessions`)
      .get() as { total: number; indexed: number | null };
    return { total: row.total, indexed: row.indexed ?? 0 };
  }

  getFileState(path: string): FileState | undefined {
    const row = this.db.prepare('SELECT * FROM files WHERE path = ?').get(path) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      path: row.path as string,
      source: row.source as string,
      sessionId: (row.session_id as string | null) ?? null,
      kind: row.kind as string,
      size: row.size as number,
      mtimeMs: row.mtime_ms as number,
      headHash: (row.head_hash as string | null) ?? null,
      parsedBytes: row.parsed_bytes as number,
      accState: (row.acc_state as string | null) ?? null,
    };
  }

  /** Session ids already hydrated, so a refresh can skip them cheaply. */
  hydratedSessionIds(source: string): Set<string> {
    const rows = this.db
      .prepare('SELECT session_id FROM sessions WHERE source = ? AND pending = 0')
      .all(source) as { session_id: string }[];
    return new Set(rows.map((r) => r.session_id));
  }

  getRow(source: string, sessionId: string): SessionRow | undefined {
    const row = this.db
      .prepare('SELECT * FROM sessions WHERE source = ? AND session_id = ?')
      .get(source, sessionId) as StoredSession | undefined;
    return row === undefined ? undefined : toSessionRow(row);
  }

  // -- writes ---------------------------------------------------------------

  putFileState(state: FileState): void {
    this.db
      .prepare(
        `INSERT INTO files (path, source, session_id, kind, size, mtime_ms, head_hash, parsed_bytes, acc_state)
         VALUES (@path, @source, @sessionId, @kind, @size, @mtimeMs, @headHash, @parsedBytes, @accState)
         ON CONFLICT(path) DO UPDATE SET
           source = excluded.source, session_id = excluded.session_id, kind = excluded.kind,
           size = excluded.size, mtime_ms = excluded.mtime_ms, head_hash = excluded.head_hash,
           parsed_bytes = excluded.parsed_bytes, acc_state = excluded.acc_state`,
      )
      .run(state as unknown as Record<string, unknown>);
  }

  upsertSessions(rows: SessionRow[]): void {
    const stmt = this.db.prepare(
      `INSERT INTO sessions (
         source, session_id, repository, title, title_derived, started_at_ms, ended_at_ms,
         duration_ms, interaction_count, llm_calls, tool_calls, input_tokens, output_tokens,
         cached_tokens, model, agent_modes, state_label, external_url, cost_micros, main_path,
         pending, indexed_at_ms
       ) VALUES (
         @source, @sessionId, @repository, @title, @titleDerived, @startedAtMs, @endedAtMs,
         @durationMs, @interactionCount, @llmCalls, @toolCalls, @inputTokens, @outputTokens,
         @cachedTokens, @model, @agentModes, @stateLabel, @externalUrl, @costMicros, @mainPath,
         @pending, @indexedAtMs
       )
       ON CONFLICT(source, session_id) DO UPDATE SET
         repository = excluded.repository,
         -- A discovery placeholder must never overwrite real parsed values, so
         -- a pending write keeps whatever a previous hydration established.
         title = CASE WHEN excluded.pending = 1 THEN COALESCE(sessions.title, excluded.title) ELSE excluded.title END,
         title_derived = CASE WHEN excluded.pending = 1 THEN sessions.title_derived ELSE excluded.title_derived END,
         started_at_ms = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.started_at_ms ELSE excluded.started_at_ms END,
         ended_at_ms = excluded.ended_at_ms,
         duration_ms = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.duration_ms ELSE excluded.duration_ms END,
         interaction_count = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.interaction_count ELSE excluded.interaction_count END,
         llm_calls = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.llm_calls ELSE excluded.llm_calls END,
         tool_calls = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.tool_calls ELSE excluded.tool_calls END,
         input_tokens = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.input_tokens ELSE excluded.input_tokens END,
         output_tokens = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.output_tokens ELSE excluded.output_tokens END,
         cached_tokens = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.cached_tokens ELSE excluded.cached_tokens END,
         model = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.model ELSE excluded.model END,
         agent_modes = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.agent_modes ELSE excluded.agent_modes END,
         state_label = excluded.state_label,
         external_url = excluded.external_url,
         cost_micros = CASE WHEN excluded.pending = 1 AND sessions.pending = 0 THEN sessions.cost_micros ELSE excluded.cost_micros END,
         main_path = COALESCE(excluded.main_path, sessions.main_path),
         pending = CASE WHEN excluded.pending = 1 THEN sessions.pending ELSE 0 END,
         indexed_at_ms = excluded.indexed_at_ms`,
    );
    const run = this.db.transaction((batch: SessionRow[]) => {
      for (const row of batch) {
        stmt.run(toStoredParams(row));
      }
    });
    run(rows);
  }

  /** Remove sessions whose files are gone, returning the keys removed. */
  removeMissing(source: string, presentIds: Set<string>): string[] {
    const existing = this.db
      .prepare('SELECT session_id FROM sessions WHERE source = ?')
      .all(source) as { session_id: string }[];
    const gone = existing.map((r) => r.session_id).filter((id) => !presentIds.has(id));
    if (gone.length === 0) {
      return [];
    }
    const del = this.db.prepare('DELETE FROM sessions WHERE source = ? AND session_id = ?');
    const delFiles = this.db.prepare('DELETE FROM files WHERE source = ? AND session_id = ?');
    const run = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        del.run(source, id);
        delFiles.run(source, id);
      }
    });
    run(gone);
    return gone.map((id) => `${source}:${id}`);
  }

  /** A session's cached title plus the fingerprint of the file it came from. */
  getTitle(sessionId: string): { title?: string; derived: boolean; srcPath: string; srcMtimeMs: number } | undefined {
    const row = this.db.prepare('SELECT * FROM titles WHERE session_id = ?').get(sessionId) as
      | { title: string | null; derived: number; src_path: string; src_mtime_ms: number }
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      title: row.title ?? undefined,
      derived: row.derived === 1,
      srcPath: row.src_path,
      srcMtimeMs: row.src_mtime_ms,
    };
  }

  /**
   * Record a title and the fingerprint it came from. A file with no readable
   * title is still recorded, so it is not re-read on every pass.
   */
  putTitle(
    sessionId: string,
    title: string | undefined,
    derived: boolean,
    srcPath: string,
    srcMtimeMs: number,
  ): void {
    this.db
      .prepare(
        `INSERT INTO titles (session_id, title, derived, src_path, src_mtime_ms)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           title = excluded.title, derived = excluded.derived,
           src_path = excluded.src_path, src_mtime_ms = excluded.src_mtime_ms`,
      )
      .run(sessionId, title ?? null, derived ? 1 : 0, srcPath, srcMtimeMs);
  }

  /** Every known title, for joining onto a batch of sessions. */
  allTitles(): Map<string, { title: string; derived: boolean }> {
    const rows = this.db
      .prepare(`SELECT session_id, title, derived FROM titles WHERE title IS NOT NULL AND title <> ''`)
      .all() as { session_id: string; title: string; derived: number }[];
    return new Map(rows.map((r) => [r.session_id, { title: r.title, derived: r.derived === 1 }]));
  }

  getCachedRepository(cwd: string): string | undefined {
    const row = this.db.prepare('SELECT repository FROM repo_cache WHERE cwd = ?').get(cwd) as
      | { repository: string }
      | undefined;
    return row?.repository;
  }

  putCachedRepository(cwd: string, repository: string, nowMs: number): void {
    this.db
      .prepare(
        `INSERT INTO repo_cache (cwd, repository, resolved_at_ms) VALUES (?, ?, ?)
         ON CONFLICT(cwd) DO UPDATE SET repository = excluded.repository, resolved_at_ms = excluded.resolved_at_ms`,
      )
      .run(cwd, repository, nowMs);
  }
}

/** Hard ceiling so a bad `limit` cannot ask for the whole table. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return 200;
  }
  return Math.min(Math.floor(limit), 2000);
}

function buildFilter(params: ListSessionsParams): { where: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  if (params.source !== undefined && params.source.length > 0) {
    clauses.push('source = ?');
    args.push(params.source);
  }
  if (params.repository !== undefined && params.repository.length > 0) {
    clauses.push('repository = ?');
    args.push(params.repository);
  }
  const query = params.query?.trim();
  if (query !== undefined && query.length > 0) {
    // ESCAPE is required for the backslashes below to mean anything: without it
    // SQLite treats them as literal characters and a search for "100%" matches
    // everything instead of the one session that says it.
    clauses.push(
      `(title LIKE ? ESCAPE '\\' OR repository LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\')`,
    );
    const like = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(like, like, like);
  }
  return { where: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, args };
}

function toSessionRow(row: StoredSession): SessionRow {
  return {
    source: row.source,
    sessionId: row.session_id,
    repository: row.repository,
    title: row.title ?? undefined,
    titleDerived: row.title_derived === 1,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    durationMs: row.duration_ms,
    interactionCount: row.interaction_count,
    llmCalls: row.llm_calls,
    toolCalls: row.tool_calls,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cachedTokens: row.cached_tokens,
    model: row.model,
    agentModes: parseModes(row.agent_modes),
    stateLabel: row.state_label ?? undefined,
    externalUrl: row.external_url ?? undefined,
    costMicros: row.cost_micros ?? undefined,
    indexedAtMs: row.indexed_at_ms,
    pending: row.pending === 1 ? true : undefined,
  };
}

function parseModes(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toStoredParams(row: SessionRow & { mainPath?: string }): Record<string, unknown> {
  return {
    source: row.source,
    sessionId: row.sessionId,
    repository: row.repository,
    title: row.title ?? null,
    titleDerived: row.titleDerived === true ? 1 : 0,
    startedAtMs: row.startedAtMs,
    endedAtMs: row.endedAtMs,
    durationMs: row.durationMs,
    interactionCount: row.interactionCount,
    llmCalls: row.llmCalls,
    toolCalls: row.toolCalls,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cachedTokens: row.cachedTokens,
    model: row.model,
    agentModes: JSON.stringify(row.agentModes ?? []),
    stateLabel: row.stateLabel ?? null,
    externalUrl: row.externalUrl ?? null,
    costMicros: row.costMicros ?? null,
    mainPath: row.mainPath ?? null,
    pending: row.pending === true ? 1 : 0,
    indexedAtMs: row.indexedAtMs,
  };
}
