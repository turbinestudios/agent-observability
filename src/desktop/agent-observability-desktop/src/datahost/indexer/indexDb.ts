import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Database from 'better-sqlite3';
import type {
  DayPoint,
  HotspotRow,
  HotspotSessionRow,
  ListSessionsParams,
  OverviewData,
  OverviewWindow,
  RetroListRow,
  RetroVerdict,
  SessionGroup,
  SessionRow,
  ThemeRow,
  VerdictDayPoint,
} from '../../shared/rpc';
import { INSIGHT_THEME_LIMIT, MAX_DAILY_COLUMNS, windowStartMs } from '../../shared/rpc';
import type { SessionAnalysis } from '../analysis/sessionAnalyzer';

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
export const SCHEMA_VERSION = 5;

/**
 * How many of the most recent sessions the background analysis reads.
 *
 * Analysis means PARSING a session — for Claude, its transcript plus a walk of
 * the `.claude` tree — so it cannot cover unbounded history without burning CPU
 * for hours after every rebuild. Core's comparable bound for the same job is
 * `HOTSPOT_SESSION_LIMIT` (150); this is larger because one pass here serves two
 * features. Sessions outside the window keep whatever analysis they already had
 * and are otherwise left alone — the UI says so rather than implying full
 * coverage.
 */
export const ANALYSIS_SESSION_LIMIT = 300;

/** Rows returned by one hotspots query — far more than a ranking is read past. */
export const HOTSPOT_ROW_LIMIT = 200;

/** Rows returned by one Retro-view query — same rationale as the hotspots cap. */
export const RETRO_ROW_LIMIT = 200;

/**
 * How many repositories the overview ranks. Ten rather than a handful: with a
 * short list, several repositories tie on the same count and real work drops
 * off the bottom for no reason a reader can see.
 */
export const TOP_REPOSITORY_LIMIT = 10;

/** How many models the overview's cost-by-model table ranks. */
export const TOP_MODEL_LIMIT = 10;

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

-- Optional change tokens for sources that aggregate again on each pass.
-- Additive sidecar: existing v5 indexes need no rebuild. Missing tokens are
-- treated as unknown, so their first refresh establishes a fresh baseline.
CREATE TABLE IF NOT EXISTS session_fingerprints (
  source      TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  fingerprint TEXT,
  PRIMARY KEY (source, session_id)
);

-- Copilot titles, so the multi-gigabyte chat-session scan happens once per
-- changed file instead of on every refresh.
CREATE TABLE IF NOT EXISTS titles (
  session_id   TEXT PRIMARY KEY,
  title        TEXT,
  derived      INTEGER NOT NULL DEFAULT 0,
  src_path     TEXT NOT NULL,
  src_mtime_ms REAL NOT NULL
);

-- What the background analysis found in a session, keyed to the indexed row it
-- was computed from: when indexed_at_ms no longer matches the session's, the
-- transcript changed and the analysis is stale.
CREATE TABLE IF NOT EXISTS session_analysis (
  source          TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  deviation_count INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  -- Session retrospective projection (counts and enum labels only — never
  -- content strings). verdict NULL means "not judged": rows written before the
  -- feature existed, or a session whose retrospective could not be built.
  -- NULL must never render as 'smooth'.
  verdict              TEXT,
  outcome              TEXT,
  correction_turns     INTEGER NOT NULL DEFAULT 0,
  repeated_prompt_turns INTEGER NOT NULL DEFAULT 0,
  interruptions        INTEGER NOT NULL DEFAULT 0,
  error_streaks        INTEGER NOT NULL DEFAULT 0,
  max_error_streak     INTEGER NOT NULL DEFAULT 0,
  long_tail_turns      INTEGER NOT NULL DEFAULT 0,
  compactions          INTEGER NOT NULL DEFAULT 0,
  churn_ratio_pct      INTEGER NOT NULL DEFAULT 0,
  plan_mode_used       INTEGER NOT NULL DEFAULT 0,
  first_prompt_rating  TEXT,
  tip_count            INTEGER NOT NULL DEFAULT 0,
  indexed_at_ms   INTEGER NOT NULL DEFAULT 0,
  analyzed_at_ms  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, session_id)
);

-- One row per (session, customization file) — the grain the Context Hotspots
-- ranking folds over. LOCAL-ONLY: absolute paths live here exactly as
-- sessions.main_path already does, and nothing in this table feeds sync.
CREATE TABLE IF NOT EXISTS context_files (
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  file       TEXT NOT NULL,
  name       TEXT NOT NULL,
  category   TEXT NOT NULL,
  status     TEXT NOT NULL,
  est_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (source, session_id, file)
);
CREATE INDEX IF NOT EXISTS idx_context_files_file ON context_files (file);

-- One row per (session, retrospective signal) — the grain the Dashboard's
-- "Recurring friction themes" card folds over. Ids, severities and counts
-- only, never content strings: the same LOCAL-ONLY class as session_analysis.
CREATE TABLE IF NOT EXISTS session_findings (
  source     TEXT NOT NULL,
  session_id TEXT NOT NULL,
  -- Core's stable RetrospectiveSignalId.
  signal_id  TEXT NOT NULL,
  -- Worst severity across the session's occurrences: 'info'|'friction'|'blocker'.
  severity   TEXT NOT NULL,
  -- Occurrences within the session.
  count      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (source, session_id, signal_id)
);
CREATE INDEX IF NOT EXISTS idx_session_findings_signal ON session_findings (signal_id);

-- Resolving a git remote means walking up to a .git/config; cache it per cwd.
CREATE TABLE IF NOT EXISTS repo_cache (
  cwd            TEXT PRIMARY KEY,
  repository     TEXT NOT NULL,
  resolved_at_ms INTEGER NOT NULL
);
`;

/**
 * Every table keyed by `(source, session_id)`. Deleting a session walks this
 * list, so adding a per-session table cannot leave orphans behind.
 */
const SESSION_OWNED_TABLES = [
  'sessions',
  'session_fingerprints',
  'files',
  'session_analysis',
  'session_findings',
  'context_files',
] as const;

/**
 * The session list reads its rows through a LEFT JOIN onto the analysis table,
 * so a row carries its deviation count without a second query and the Deviations
 * chip can filter in SQL. LEFT, not INNER: an unanalyzed session must still list.
 */
const SESSION_SELECT = 's.*, a.deviation_count AS deviation_count, a.verdict AS verdict';
const SESSION_FROM =
  'FROM sessions s LEFT JOIN session_analysis a' +
  ' ON a.source = s.source AND a.session_id = s.session_id';

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
  /** Joined from `session_analysis`; null while the session is unanalyzed. */
  deviation_count?: number | null;
  /** Joined from `session_analysis`; null while unanalyzed or unjudgeable. */
  verdict?: string | null;
}

/**
 * Session keys the index cannot derive for itself, because the data behind them
 * lives in the JSON stores beside it — tags and user-chosen names.
 *
 * They are passed INTO the query rather than applied to its results so that
 * filtering, ordering, `LIMIT` and `OFFSET` all happen once, in SQL. Filtering
 * afterwards would make a page silently short and paging incorrect.
 */
export interface SessionKeyOverlay {
  /** AND-ed: the list is narrowed to these keys. Backs the tag filter. */
  restrictKeys?: readonly string[];
  /** OR-ed into the text predicate: sessions matched only by a user-chosen name. */
  renameKeys?: readonly string[];
}

/** One session the background analysis still has to read. */
export interface AnalysisTarget {
  source: string;
  sessionId: string;
  /** The indexed row version this analysis will be pinned to. */
  indexedAtMs: number;
}

/** Sessions listed per expanded hotspot row — long enough to spot a pattern. */
const HOTSPOT_SESSION_ROW_LIMIT = 50;

/** Raw shape of a hotspot session before the counts become booleans. */
interface StoredHotspotSession {
  source: string;
  sessionId: string;
  repository: string;
  title: string | null;
  endedAtMs: number;
  status: string;
  estTokens: number;
  errors: number;
  deviations: number;
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

  constructor(file: string = resolveIndexDbPath(), options: { initialize?: boolean } = {}) {
    this.db = new Database(file, { fileMustExist: options.initialize === false });
    if (options.initialize !== false) {
      this.db.pragma('journal_mode = WAL');
    }
    // NORMAL is the right durability trade for a rebuildable cache: it survives
    // process crashes, and the worst a power loss costs is a re-index.
    this.db.pragma('synchronous = NORMAL');
    if (options.initialize !== false) {
      this.db.exec(SCHEMA);
      this.ensureVersion();
    } else {
      try {
        const version = this.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
          { value: string } | undefined;
        if (Number(version?.value) !== SCHEMA_VERSION) {
          throw new Error('Background worker requires an initialized, current index.');
        }
      } catch (error) {
        this.db.close();
        throw error;
      }
    }
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
      this.db.exec(
        'DROP TABLE IF EXISTS files; DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS titles;' +
          ' DROP TABLE IF EXISTS repo_cache; DROP TABLE IF EXISTS session_analysis;' +
          ' DROP TABLE IF EXISTS session_fingerprints;' +
          ' DROP TABLE IF EXISTS session_findings; DROP TABLE IF EXISTS context_files;',
      );
      this.db.exec(SCHEMA);
    }
    this.db
      .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(String(SCHEMA_VERSION));
  }

  /** Erase all indexed data, keeping the schema. Backs the rebuild command. */
  clear(): void {
    this.db.exec(
      'DELETE FROM files; DELETE FROM sessions; DELETE FROM titles; DELETE FROM repo_cache;' +
        ' DELETE FROM session_fingerprints;' +
        ' DELETE FROM session_analysis; DELETE FROM session_findings; DELETE FROM context_files;',
    );
  }

  close(): void {
    this.db.close();
  }

  /** Metadata-only identities for removal notifications and rebuilds. */
  sessionKeys(): string[] {
    return (this.db.prepare('SELECT source, session_id FROM sessions').all() as
      { source: string; session_id: string }[]).map((row) => `${row.source}:${row.session_id}`);
  }

  // -- reads ----------------------------------------------------------------

  listSessions(
    params: ListSessionsParams,
    hiddenKeys: readonly string[] = [],
    overlay: SessionKeyOverlay = {},
  ): SessionRow[] {
    const { where, args } = buildFilter(params, hiddenKeys, overlay);
    const limit = clampLimit(params.limit);
    const offset = Math.max(0, params.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_SELECT} ${SESSION_FROM} ${where}
          ORDER BY s.ended_at_ms DESC, s.session_id DESC LIMIT ? OFFSET ?`,
      )
      .all(...args, limit, offset) as StoredSession[];
    return rows.map(toSessionRow);
  }

  countSessions(
    params: ListSessionsParams,
    hiddenKeys: readonly string[] = [],
    overlay: SessionKeyOverlay = {},
  ): number {
    const { where, args } = buildFilter(params, hiddenKeys, overlay);
    const row = this.db.prepare(`SELECT COUNT(*) AS n ${SESSION_FROM} ${where}`).get(...args) as {
      n: number;
    };
    return row.n;
  }

  listGroups(hiddenKeys: readonly string[] = []): SessionGroup[] {
    // Counts here drive the filter chips, so they must agree with what the
    // list actually shows.
    const exclude =
      hiddenKeys.length === 0
        ? ''
        : `WHERE source || ':' || session_id NOT IN (${hiddenKeys.map(() => '?').join(', ')})`;
    return this.db
      .prepare(
        `SELECT source, repository, COUNT(*) AS count, MAX(ended_at_ms) AS newestMs
         FROM sessions ${exclude} GROUP BY source, repository ORDER BY newestMs DESC`,
      )
      .all(...hiddenKeys) as SessionGroup[];
  }

  /** Forget a session entirely, so a deleted one does not linger in the index. */
  removeSession(source: string, sessionId: string): void {
    for (const table of SESSION_OWNED_TABLES) {
      this.db.prepare(`DELETE FROM ${table} WHERE source = ? AND session_id = ?`).run(source, sessionId);
    }
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
      .prepare(`SELECT ${SESSION_SELECT} ${SESSION_FROM} WHERE s.source = ? AND s.session_id = ?`)
      .get(source, sessionId) as StoredSession | undefined;
    return row === undefined ? undefined : toSessionRow(row);
  }

  /**
   * Rows for specific `source:sessionId` keys, newest first.
   *
   * Used to pull in sessions a text search can only match by their user-chosen
   * name — the index stores the original, so SQL alone cannot find them.
   */
  getRowsByKey(keys: readonly string[]): SessionRow[] {
    if (keys.length === 0) {
      return [];
    }
    const placeholders = keys.map(() => '?').join(', ');
    const rows = this.db
      .prepare(
        `SELECT ${SESSION_SELECT} ${SESSION_FROM}
          WHERE s.source || ':' || s.session_id IN (${placeholders})
          ORDER BY s.ended_at_ms DESC`,
      )
      .all(...keys) as StoredSession[];
    return rows.map(toSessionRow);
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

  /** Commit parsed summaries and their source fingerprints as one unit. */
  upsertHydratedSessions(entries: { row: SessionRow; file: FileState }[]): void {
    this.db.transaction(() => {
      this.upsertSessions(entries.map((entry) => entry.row));
      for (const entry of entries) {
        this.putFileState(entry.file);
      }
    })();
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

  /**
   * Write only rows whose source or indexed metadata changed. The fingerprint
   * covers data the summary cannot see (tool arguments, errors, child spans).
   * An unknown fingerprint deliberately forces a write; a known one is never
   * enough on its own, since titles/repositories can change outside the source.
   *
   * Keep indexedAtMs stable on a no-op so persisted analysis and open detail
   * documents stay valid. On a change it is a strictly advancing revision,
   * even for two passes in one millisecond or after a clock adjustment.
   * Fingerprints and rows commit together, including when the app exits early.
   */
  upsertChangedSessions(rows: SessionRow[], fingerprint: string | undefined): SessionRow[] {
    const previous = this.db.prepare(
      `SELECT s.*, f.fingerprint FROM sessions s
         LEFT JOIN session_fingerprints f ON f.source = s.source AND f.session_id = s.session_id
        WHERE s.source = ? AND s.session_id = ?`,
    );
    const putFingerprint = this.db.prepare(
      `INSERT INTO session_fingerprints (source, session_id, fingerprint) VALUES (?, ?, ?)
       ON CONFLICT(source, session_id) DO UPDATE SET fingerprint = excluded.fingerprint`,
    );
    return this.db.transaction(() => {
      const changed: SessionRow[] = [];
      for (const row of rows) {
        const old = previous.get(row.source, row.sessionId) as
          | (StoredSession & { fingerprint: string | null })
          | undefined;
        if (old !== undefined && fingerprint !== undefined && old.fingerprint === fingerprint) {
          const before = toStoredParams({ ...toSessionRow(old), mainPath: old.main_path ?? undefined });
          const after = toStoredParams(row);
          // Ignore the check time; compare only the persisted source metadata,
          // never annotations or previously computed analysis on the list row.
          before.indexedAtMs = after.indexedAtMs;
          if (isDeepStrictEqual(before, after)) {
            continue;
          }
        }
        changed.push({
          ...row,
          indexedAtMs: old === undefined ? row.indexedAtMs : Math.max(row.indexedAtMs, old.indexed_at_ms + 1),
        });
      }
      if (changed.length > 0) {
        this.upsertSessions(changed);
        for (const row of changed) {
          putFingerprint.run(row.source, row.sessionId, fingerprint ?? null);
        }
      }
      return changed;
    })();
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
    const statements = SESSION_OWNED_TABLES.map((table) =>
      this.db.prepare(`DELETE FROM ${table} WHERE source = ? AND session_id = ?`),
    );
    const run = this.db.transaction((ids: string[]) => {
      for (const id of ids) {
        for (const statement of statements) {
          statement.run(source, id);
        }
      }
    });
    run(gone);
    return gone.map((id) => `${source}:${id}`);
  }

  /**
   * Everything the overview shows, in a handful of aggregate queries over the
   * index.
   *
   * All of it comes from indexed columns, so this stays a few milliseconds even
   * with thousands of sessions — the view can open instantly instead of the
   * user watching sources be re-read.
   *
   * The window narrows EVERY figure, not just the daily series: a page whose
   * tiles are all-time and whose charts are not puts two time scales side by
   * side and invites the reader to compare them. `'all'` is the way back to
   * uncapped totals.
   */
  overview(window: OverviewWindow, hiddenKeys: readonly string[] = []): OverviewData {
    // Both the cutoff and the chart's buckets start at a LOCAL midnight, so a
    // "7 days" window is today plus the six days before it — exactly the seven
    // columns the chart draws — rather than a rolling 168 hours that half-fills
    // a column nobody can see.
    const cutoff = window === 'all' ? 0 : windowStartMs(window);

    // Applied to every aggregate below, so the totals, the per-source split,
    // the daily series, and the repository ranking all count the same sessions.
    const scope: string[] = [];
    const scopeArgs: unknown[] = [];
    if (cutoff > 0) {
      scope.push('ended_at_ms >= ?');
      scopeArgs.push(cutoff);
    }
    if (hiddenKeys.length > 0) {
      scope.push(`source || ':' || session_id NOT IN (${hiddenKeys.map(() => '?').join(', ')})`);
      scopeArgs.push(...hiddenKeys);
    }
    const whereExcl = scope.length === 0 ? '' : `WHERE ${scope.join(' AND ')}`;
    const andExcl = scope.length === 0 ? '' : `AND ${scope.join(' AND ')}`;
    const hk = scopeArgs;

    // How many day columns to draw. A real window says so itself; 'all' has to
    // ask the index how far back the history actually goes, and stop at
    // MAX_DAILY_COLUMNS so years of it are not drawn as a thousand slivers.
    const { windowDays, dailyCapped } = this.dailySpan(window, hiddenKeys);
    const dailyCutoff = windowStartMs(windowDays);

    // Cost sums SKIP NULLs by SQL semantics, which is the honesty rule: an
    // unpriced session (NULL cost_micros) contributes nothing rather than a
    // fake 0, and COUNT(cost_micros) — non-NULL rows only — is the "covers N of
    // M sessions" denominator the tile footnotes with.
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(interaction_count), 0) AS steps,
                COALESCE(SUM(llm_calls), 0) AS llmCalls,
                COALESCE(SUM(tool_calls), 0) AS toolCalls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
                COALESCE(SUM(cost_micros), 0) AS costMicros,
                COUNT(cost_micros) AS costSessions,
                COUNT(DISTINCT CASE WHEN repository <> 'unknown' THEN repository END) AS repositories,
                COUNT(DISTINCT CASE WHEN model <> 'unknown' THEN model END) AS models,
                COALESCE(AVG(NULLIF(duration_ms, 0)), 0) AS avgSessionMs
           FROM sessions ${whereExcl}`,
      )
      .get(...hk) as OverviewData['totals'];

    const bySource = this.db
      .prepare(
        `SELECT source,
                COUNT(*) AS sessions,
                COALESCE(SUM(interaction_count), 0) AS steps,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cost_micros), 0) AS costMicros
           FROM sessions ${whereExcl}
          GROUP BY source
          ORDER BY sessions DESC`,
      )
      .all(...hk) as OverviewData['bySource'];

    // Local time, so a day boundary matches what the user considers a day.
    // Rows with no timestamp would land on 1970 and stretch the axis.
    const daily = this.db
      .prepare(
        `SELECT date(ended_at_ms / 1000, 'unixepoch', 'localtime') AS day,
                source,
                COUNT(*) AS sessions,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                COALESCE(SUM(cost_micros), 0) AS costMicros
           FROM sessions
          WHERE ended_at_ms > 0
            AND ended_at_ms >= ?
            ${andExcl}
          GROUP BY day, source
          ORDER BY day ASC`,
      )
      .all(dailyCutoff, ...hk) as DayPoint[];

    // Ties are common — several repositories sitting on the same count — so the
    // order needs a second key, or SQLite picks arbitrarily and a repository can
    // vanish from the list between runs for no visible reason.
    const topRepositories = this.db
      .prepare(
        `SELECT repository, COUNT(*) AS sessions
           FROM sessions
          WHERE repository <> 'unknown'
            ${andExcl}
          GROUP BY repository
          ORDER BY sessions DESC, repository ASC
          LIMIT ?`,
      )
      .all(...hk, TOP_REPOSITORY_LIMIT) as OverviewData['topRepositories'];

    // Cost by DOMINANT session model: sessions.model is the session's most-used
    // model, so a multi-model session's whole cost lands on that one row —
    // acceptable at this grain (the detail view has the exact per-model split).
    // A NULL costMicros here means NO session of that model could be priced
    // ("n/a"), which SUM's NULL-skipping distinguishes from a genuine 0. The
    // NULL-last ordering is spelled out so unpriced models sink without relying
    // on NULLS LAST support; sessions + name break ties deterministically.
    const byModel = this.db
      .prepare(
        `SELECT model,
                COUNT(*) AS sessions,
                COALESCE(SUM(llm_calls), 0) AS llmCalls,
                COALESCE(SUM(input_tokens), 0) AS inputTokens,
                COALESCE(SUM(output_tokens), 0) AS outputTokens,
                SUM(cost_micros) AS costMicros
           FROM sessions
          WHERE 1 = 1
            ${andExcl}
          GROUP BY model
          ORDER BY (costMicros IS NULL) ASC, costMicros DESC, sessions DESC, model ASC
          LIMIT ?`,
      )
      .all(...hk, TOP_MODEL_LIMIT) as OverviewData['byModel'];

    return {
      totals,
      bySource,
      daily,
      windowDays,
      window,
      ...(dailyCapped ? { dailyCapped: true as const } : {}),
      topRepositories,
      byModel,
    };
  }

  /**
   * How many day columns the charts should draw, and whether that is less than
   * the history behind them.
   *
   * A chosen window answers for itself. `'all'` has to look: the oldest session
   * sets the span, capped at {@link MAX_DAILY_COLUMNS} — and when the cap bites,
   * the caller has to say so, because the tiles above the charts are still
   * counting everything.
   */
  private dailySpan(
    window: OverviewWindow,
    hiddenKeys: readonly string[],
  ): { windowDays: number; dailyCapped?: true } {
    if (window !== 'all') {
      return { windowDays: window };
    }
    const exclude =
      hiddenKeys.length === 0
        ? ''
        : `AND source || ':' || session_id NOT IN (${hiddenKeys.map(() => '?').join(', ')})`;
    const row = this.db
      .prepare(`SELECT MIN(ended_at_ms) AS oldest FROM sessions WHERE ended_at_ms > 0 ${exclude}`)
      .get(...hiddenKeys) as { oldest: number | null };
    if (row.oldest === null) {
      return { windowDays: 1 };
    }
    const start = new Date(row.oldest);
    start.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Rounded, not floored: a DST boundary inside the span makes one of these
    // days 23 or 25 hours long, which would otherwise drop or duplicate a day.
    const span = Math.round((today.getTime() - start.getTime()) / 86_400_000) + 1;
    return span > MAX_DAILY_COLUMNS
      ? { windowDays: MAX_DAILY_COLUMNS, dailyCapped: true }
      : { windowDays: Math.max(1, span) };
  }

  /**
   * The Dashboard's insight aggregates: verdict-per-day and recurring finding
   * themes. Scored hotspots ride the existing {@link IndexDb.hotspots} query so
   * the two views can never disagree; the caller composes all three.
   *
   * The verdict series LEFT JOINs the analysis table so unanalyzed sessions
   * count as `'unjudged'` — by construction each day's buckets sum to exactly
   * the sessions the overview's daily chart counts, and a fresh rebuild renders
   * as gray filling in rather than an empty chart.
   */
  insights(
    window: OverviewWindow,
    hiddenKeys: readonly string[] = [],
  ): { verdictDaily: VerdictDayPoint[]; themes: ThemeRow[]; windowDays: number; dailyCapped?: true } {
    const exclude =
      hiddenKeys.length === 0
        ? ''
        : `AND s.source || ':' || s.session_id NOT IN (${hiddenKeys.map(() => '?').join(', ')})`;

    // Same day span and local-midnight bucketing as the overview's daily series.
    const { windowDays, dailyCapped } = this.dailySpan(window, hiddenKeys);
    const dailyCutoff = windowStartMs(windowDays);

    const stored = this.db
      .prepare(
        `SELECT date(s.ended_at_ms / 1000, 'unixepoch', 'localtime') AS day,
                a.verdict AS verdict,
                COUNT(*) AS sessions
           FROM sessions s
           LEFT JOIN session_analysis a ON a.source = s.source AND a.session_id = s.session_id
          WHERE s.ended_at_ms > 0
            AND s.ended_at_ms >= ?
            ${exclude}
          GROUP BY day, a.verdict
          ORDER BY day ASC`,
      )
      .all(dailyCutoff, ...hiddenKeys) as { day: string; verdict: string | null; sessions: number }[];

    // Fold unknown labels into 'unjudged' AFTER the query: toVerdict is the one
    // arbiter of what counts as a verdict, and SQL must not grow a second one.
    const merged = new Map<string, VerdictDayPoint>();
    for (const row of stored) {
      const verdict = toVerdict(row.verdict) ?? 'unjudged';
      const key = `${row.day}:${verdict}`;
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, { day: row.day, verdict, sessions: row.sessions });
      } else {
        existing.sessions += row.sessions;
      }
    }

    // Themes rank by distinct sessions affected — honest recurrence — with
    // total occurrences and the id as deterministic tie-breaks. Info-severity
    // findings are observations, not friction, and stay out of the card.
    const cutoff = window === 'all' ? 0 : windowStartMs(window);
    const themes = this.db
      .prepare(
        `SELECT f.signal_id AS signalId,
                COUNT(*) AS sessions,
                COALESCE(SUM(f.count), 0) AS occurrences
           FROM session_findings f
           JOIN sessions s ON s.source = f.source AND s.session_id = f.session_id
          WHERE f.severity <> 'info'
            AND s.ended_at_ms >= ?
            ${exclude}
          GROUP BY f.signal_id
          ORDER BY sessions DESC, occurrences DESC, f.signal_id ASC
          LIMIT ?`,
      )
      .all(cutoff, ...hiddenKeys, INSIGHT_THEME_LIMIT) as ThemeRow[];

    return {
      verdictDaily: [...merged.values()],
      themes,
      windowDays,
      ...(dailyCapped ? { dailyCapped: true as const } : {}),
    };
  }

  // -- workspace: repository hubs -------------------------------------------

  /**
   * One row per repository active in the window, with its verdict mix and
   * cost folded in. `unknown` is reported separately rather than ranked: a
   * card for "sessions whose repository could not be resolved" is a note, not
   * a repository.
   */
  repositoryCards(
    window: OverviewWindow,
    hiddenKeys: readonly string[] = [],
  ): { cards: RepositoryCardRow[]; unknownSessions: number } {
    const cutoff = window === 'all' ? 0 : windowStartMs(window);
    const { where, args } = repoScope(undefined, cutoff, undefined, hiddenKeys);

    // Grouped by the raw verdict label and folded in JS: toVerdict is the one
    // arbiter of what counts as a verdict, and SQL must not grow a second one.
    const stored = this.db
      .prepare(
        `SELECT s.repository AS repository,
                a.verdict AS verdict,
                COUNT(*) AS sessions,
                COALESCE(MAX(s.ended_at_ms), 0) AS lastActivityMs,
                COALESCE(SUM(s.cost_micros), 0) AS costMicros,
                COUNT(s.cost_micros) AS costSessions
           FROM sessions s
           LEFT JOIN session_analysis a ON a.source = s.source AND a.session_id = s.session_id
           ${where}
          GROUP BY s.repository, a.verdict`,
      )
      .all(...args) as {
      repository: string;
      verdict: string | null;
      sessions: number;
      lastActivityMs: number;
      costMicros: number;
      costSessions: number;
    }[];

    const bySource = this.db
      .prepare(
        `SELECT s.repository AS repository, s.source AS source, COUNT(*) AS sessions
           FROM sessions s ${where}
          GROUP BY s.repository, s.source
          ORDER BY sessions DESC, s.source ASC`,
      )
      .all(...args) as { repository: string; source: string; sessions: number }[];

    const cards = new Map<string, RepositoryCardRow>();
    for (const row of stored) {
      let card = cards.get(row.repository);
      if (card === undefined) {
        card = {
          repository: row.repository,
          sessions: 0,
          lastActivityMs: 0,
          bySource: [],
          verdicts: emptyVerdicts(),
          costMicros: 0,
          costSessions: 0,
        };
        cards.set(row.repository, card);
      }
      card.sessions += row.sessions;
      card.lastActivityMs = Math.max(card.lastActivityMs, row.lastActivityMs);
      card.costMicros += row.costMicros;
      card.costSessions += row.costSessions;
      card.verdicts[toVerdict(row.verdict) ?? 'unjudged'] += row.sessions;
    }
    for (const row of bySource) {
      cards.get(row.repository)?.bySource.push({ source: row.source, sessions: row.sessions });
    }

    const unknownSessions = cards.get('unknown')?.sessions ?? 0;
    cards.delete('unknown');
    return {
      cards: [...cards.values()].sort(
        (a, b) => b.sessions - a.sessions || b.lastActivityMs - a.lastActivityMs || a.repository.localeCompare(b.repository),
      ),
      unknownSessions,
    };
  }

  /**
   * The overview totals for ONE repository over `[cutoffMs, untilMs)`. The
   * optional upper bound is what lets the hub compute the equal-length window
   * before this one for its trend figures.
   */
  repoTotals(
    repository: string,
    cutoffMs: number,
    untilMs: number | undefined,
    hiddenKeys: readonly string[] = [],
  ): OverviewData['totals'] {
    const { where, args } = repoScope(repository, cutoffMs, untilMs, hiddenKeys);
    return this.db
      .prepare(
        `SELECT COUNT(*) AS sessions,
                COALESCE(SUM(s.interaction_count), 0) AS steps,
                COALESCE(SUM(s.llm_calls), 0) AS llmCalls,
                COALESCE(SUM(s.tool_calls), 0) AS toolCalls,
                COALESCE(SUM(s.input_tokens), 0) AS inputTokens,
                COALESCE(SUM(s.output_tokens), 0) AS outputTokens,
                COALESCE(SUM(s.cached_tokens), 0) AS cachedTokens,
                COALESCE(SUM(s.cost_micros), 0) AS costMicros,
                COUNT(s.cost_micros) AS costSessions,
                COUNT(DISTINCT CASE WHEN s.repository <> 'unknown' THEN s.repository END) AS repositories,
                COUNT(DISTINCT CASE WHEN s.model <> 'unknown' THEN s.model END) AS models,
                COALESCE(AVG(NULLIF(s.duration_ms, 0)), 0) AS avgSessionMs
           FROM sessions s ${where}`,
      )
      .get(...args) as OverviewData['totals'];
  }

  /** Verdict mix for one repository over `[cutoffMs, untilMs)`; unanalyzed sessions count as unjudged. */
  repoVerdicts(
    repository: string,
    cutoffMs: number,
    untilMs: number | undefined,
    hiddenKeys: readonly string[] = [],
  ): Record<RetroVerdict | 'unjudged', number> {
    const { where, args } = repoScope(repository, cutoffMs, untilMs, hiddenKeys);
    const stored = this.db
      .prepare(
        `SELECT a.verdict AS verdict, COUNT(*) AS sessions
           FROM sessions s
           LEFT JOIN session_analysis a ON a.source = s.source AND a.session_id = s.session_id
           ${where}
          GROUP BY a.verdict`,
      )
      .all(...args) as { verdict: string | null; sessions: number }[];
    const verdicts = emptyVerdicts();
    for (const row of stored) {
      verdicts[toVerdict(row.verdict) ?? 'unjudged'] += row.sessions;
    }
    return verdicts;
  }

  /** Recurring friction themes for one repository — the insight card's query, scoped. */
  repoThemes(
    repository: string,
    cutoffMs: number,
    untilMs: number | undefined,
    hiddenKeys: readonly string[] = [],
    limit: number = INSIGHT_THEME_LIMIT,
  ): ThemeRow[] {
    const { where, args } = repoScope(repository, cutoffMs, untilMs, hiddenKeys);
    return this.db
      .prepare(
        `SELECT f.signal_id AS signalId,
                COUNT(*) AS sessions,
                COALESCE(SUM(f.count), 0) AS occurrences
           FROM session_findings f
           JOIN sessions s ON s.source = f.source AND s.session_id = f.session_id
           ${where} AND f.severity <> 'info'
          GROUP BY f.signal_id
          ORDER BY sessions DESC, occurrences DESC, f.signal_id ASC
          LIMIT ?`,
      )
      .all(...args, limit) as ThemeRow[];
  }

  /** Cost by dominant model for one repository — the overview's table, scoped. */
  repoModels(
    repository: string,
    cutoffMs: number,
    hiddenKeys: readonly string[] = [],
    limit: number = TOP_MODEL_LIMIT,
  ): OverviewData['byModel'] {
    const { where, args } = repoScope(repository, cutoffMs, undefined, hiddenKeys);
    return this.db
      .prepare(
        `SELECT s.model AS model,
                COUNT(*) AS sessions,
                COALESCE(SUM(s.llm_calls), 0) AS llmCalls,
                COALESCE(SUM(s.input_tokens), 0) AS inputTokens,
                COALESCE(SUM(s.output_tokens), 0) AS outputTokens,
                SUM(s.cost_micros) AS costMicros
           FROM sessions s ${where}
          GROUP BY s.model
          ORDER BY (costMicros IS NULL) ASC, costMicros DESC, sessions DESC, s.model ASC
          LIMIT ?`,
      )
      .all(...args, limit) as OverviewData['byModel'];
  }

  /**
   * The retrospective projection of one repository's judged sessions, with the
   * finding ids each raised — the input core's advice table needs to say which
   * tips fire most often here. Counts and enum labels only, like the table.
   */
  repoSessionFindings(
    repository: string,
    cutoffMs: number,
    hiddenKeys: readonly string[] = [],
    limit: number = ANALYSIS_SESSION_LIMIT,
  ): RepoSessionFindingsRow[] {
    const { where, args } = repoScope(repository, cutoffMs, undefined, hiddenKeys);
    const stored = this.db
      .prepare(
        `SELECT a.source AS source, a.session_id AS sessionId,
                a.verdict AS verdict, a.outcome AS outcome,
                a.correction_turns AS correctionTurns,
                a.repeated_prompt_turns AS repeatedPromptTurns,
                a.interruptions AS interruptions,
                a.error_streaks AS errorStreaks,
                a.max_error_streak AS maxErrorStreak,
                a.long_tail_turns AS longTailTurns,
                a.compactions AS compactions,
                a.churn_ratio_pct AS churnRatioPct,
                a.plan_mode_used AS planModeUsed,
                a.first_prompt_rating AS firstPromptRating,
                a.tip_count AS tipCount,
                GROUP_CONCAT(f.signal_id) AS signalIds
           FROM session_analysis a
           JOIN sessions s ON s.source = a.source AND s.session_id = a.session_id
           LEFT JOIN session_findings f ON f.source = a.source AND f.session_id = a.session_id
           ${where} AND a.verdict IS NOT NULL
          GROUP BY a.source, a.session_id
          ORDER BY s.ended_at_ms DESC
          LIMIT ?`,
      )
      .all(...args, limit) as (Omit<RepoSessionFindingsRow, 'signalIds' | 'planModeUsed' | 'verdict' | 'firstPromptRating'> & {
      signalIds: string | null;
      planModeUsed: number;
      verdict: string;
      firstPromptRating: string | null;
    })[];
    const rows: RepoSessionFindingsRow[] = [];
    for (const row of stored) {
      const verdict = toVerdict(row.verdict);
      if (verdict === undefined) {
        continue;
      }
      rows.push({
        ...row,
        verdict,
        planModeUsed: row.planModeUsed === 1,
        firstPromptRating: row.firstPromptRating ?? undefined,
        signalIds: row.signalIds === null ? [] : [...new Set(row.signalIds.split(','))],
      });
    }
    return rows;
  }

  // -- team shard inputs ----------------------------------------------------

  /**
   * One row per hydrated session that ended inside `[sinceMs, untilMs)`, with
   * its verdict (NULL = unjudged) and cost — the input to the team shard's
   * outcome rows. Counts and labels only; the shard builder closes the sets.
   */
  outcomeInputs(
    sinceMs: number,
    untilMs: number,
    hiddenKeys: readonly string[] = [],
  ): { endedAtMs: number; repository: string; source: string; verdict: string | null; costMicros: number | null }[] {
    const { where, args } = repoScope(undefined, sinceMs, untilMs, hiddenKeys);
    return this.db
      .prepare(
        `SELECT s.ended_at_ms AS endedAtMs, s.repository AS repository, s.source AS source,
                a.verdict AS verdict, s.cost_micros AS costMicros
           FROM sessions s
           LEFT JOIN session_analysis a ON a.source = s.source AND a.session_id = s.session_id
           ${where} AND s.pending = 0
          ORDER BY s.ended_at_ms ASC, s.source ASC, s.session_id ASC`,
      )
      .all(...args) as { endedAtMs: number; repository: string; source: string; verdict: string | null; costMicros: number | null }[];
  }

  /**
   * Every (session, context file) row inside the window with the session's
   * repository, start time and friction counts — the input to the team
   * shard's context-insights part. `file` is ABSOLUTE here; the collector
   * makes it repo-relative under a verified checkout root or drops it.
   */
  contextFileObservationRows(
    sinceMs: number,
    untilMs: number,
    hiddenKeys: readonly string[] = [],
  ): ContextFileObservationRow[] {
    const { where, args } = repoScope(undefined, sinceMs, untilMs, hiddenKeys);
    return this.db
      .prepare(
        `SELECT cf.source AS source, cf.session_id AS sessionId, s.repository AS repository,
                s.started_at_ms AS startedAtMs, cf.file AS file, cf.category AS category,
                cf.status AS status, cf.est_tokens AS estTokens,
                COALESCE(a.error_count, 0) AS errorCount,
                COALESCE(a.deviation_count, 0) AS deviationCount
           FROM context_files cf
           JOIN sessions s ON s.source = cf.source AND s.session_id = cf.session_id
           LEFT JOIN session_analysis a ON a.source = cf.source AND a.session_id = cf.session_id
           ${where}
          ORDER BY s.ended_at_ms ASC, cf.file ASC`,
      )
      .all(...args) as ContextFileObservationRow[];
  }

  // -- background analysis ---------------------------------------------------

  /**
   * Sessions inside the analysis window whose analysis is missing or stale,
   * newest first, capped at `batch`.
   *
   * The window is applied BEFORE the staleness test, so a rebuild works forward
   * from the most recent sessions and an old session going stale can never
   * displace a recent one. A session still awaiting hydration is skipped: its
   * counts are placeholders, so analyzing it would only have to be redone.
   */
  staleAnalysis(
    batch: number,
    window: number = ANALYSIS_SESSION_LIMIT,
    settledBeforeMs?: number,
  ): AnalysisTarget[] {
    // A live-triggered pass skips sessions still being written to: analyzing a
    // transcript that will change again in ten seconds only redoes the work.
    // Startup and Refresh passes leave the bound off and analyze everything.
    const settled = settledBeforeMs === undefined ? '' : 'AND ended_at_ms <= ?';
    const args: unknown[] = settledBeforeMs === undefined ? [window, batch] : [settledBeforeMs, window, batch];
    return this.db
      .prepare(
        `WITH recent AS (
           SELECT source, session_id, indexed_at_ms FROM sessions
            WHERE pending = 0 ${settled} ORDER BY ended_at_ms DESC LIMIT ?
         )
         SELECT r.source AS source, r.session_id AS sessionId, r.indexed_at_ms AS indexedAtMs
           FROM recent r
           LEFT JOIN session_analysis a ON a.source = r.source AND a.session_id = r.session_id
          WHERE a.indexed_at_ms IS NULL OR a.indexed_at_ms <> r.indexed_at_ms
          LIMIT ?`,
      )
      .all(...args) as AnalysisTarget[];
  }

  /** How much of the analysis window has current results, for the progress note. */
  analysisCounts(window: number = ANALYSIS_SESSION_LIMIT): { analyzed: number; total: number } {
    return this.db
      .prepare(
        `WITH recent AS (
           SELECT source, session_id, indexed_at_ms FROM sessions
            WHERE pending = 0 ORDER BY ended_at_ms DESC LIMIT ?
         )
         SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN a.indexed_at_ms = r.indexed_at_ms THEN 1 ELSE 0 END), 0) AS analyzed
           FROM recent r
           LEFT JOIN session_analysis a ON a.source = r.source AND a.session_id = r.session_id`,
      )
      .get(window) as { analyzed: number; total: number };
  }

  /**
   * Record one session's analysis, replacing whatever was there. Its
   * context-file rows are rewritten wholesale rather than merged: a file that
   * dropped out of context must leave the ranking, not linger in it.
   */
  putAnalysis(
    source: string,
    sessionId: string,
    analysis: SessionAnalysis,
    indexedAtMs: number,
    nowMs: number,
  ): void {
    const putSession = this.db.prepare(
      `INSERT INTO session_analysis
         (source, session_id, deviation_count, error_count,
          verdict, outcome, correction_turns, repeated_prompt_turns, interruptions,
          error_streaks, max_error_streak, long_tail_turns, compactions,
          churn_ratio_pct, plan_mode_used, first_prompt_rating, tip_count,
          indexed_at_ms, analyzed_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, session_id) DO UPDATE SET
         deviation_count = excluded.deviation_count,
         error_count = excluded.error_count,
         verdict = excluded.verdict,
         outcome = excluded.outcome,
         correction_turns = excluded.correction_turns,
         repeated_prompt_turns = excluded.repeated_prompt_turns,
         interruptions = excluded.interruptions,
         error_streaks = excluded.error_streaks,
         max_error_streak = excluded.max_error_streak,
         long_tail_turns = excluded.long_tail_turns,
         compactions = excluded.compactions,
         churn_ratio_pct = excluded.churn_ratio_pct,
         plan_mode_used = excluded.plan_mode_used,
         first_prompt_rating = excluded.first_prompt_rating,
         tip_count = excluded.tip_count,
         indexed_at_ms = excluded.indexed_at_ms,
         analyzed_at_ms = excluded.analyzed_at_ms`,
    );
    const clearFiles = this.db.prepare(
      'DELETE FROM context_files WHERE source = ? AND session_id = ?',
    );
    const putFile = this.db.prepare(
      `INSERT INTO context_files (source, session_id, file, name, category, status, est_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(source, session_id, file) DO UPDATE SET
         name = excluded.name, category = excluded.category, status = excluded.status,
         est_tokens = MAX(context_files.est_tokens, excluded.est_tokens)`,
    );
    const clearFindings = this.db.prepare(
      'DELETE FROM session_findings WHERE source = ? AND session_id = ?',
    );
    const putFinding = this.db.prepare(
      `INSERT INTO session_findings (source, session_id, signal_id, severity, count)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(source, session_id, signal_id) DO UPDATE SET
         severity = excluded.severity, count = excluded.count`,
    );

    this.db.transaction(() => {
      // retro === undefined means the retrospective could not be built: store
      // NULLs, never zeros pretending to be a smooth verdict.
      const retro = analysis.retro;
      putSession.run(
        source,
        sessionId,
        analysis.deviationCount,
        analysis.errorCount,
        retro?.verdict ?? null,
        retro?.outcome ?? null,
        retro?.correctionTurns ?? 0,
        retro?.repeatedPromptTurns ?? 0,
        retro?.interruptions ?? 0,
        retro?.errorStreaks ?? 0,
        retro?.maxErrorStreak ?? 0,
        retro?.longTailTurns ?? 0,
        retro?.compactions ?? 0,
        retro?.churnRatioPct ?? 0,
        retro?.planModeUsed === true ? 1 : 0,
        retro?.firstPromptRating ?? null,
        retro?.tipCount ?? 0,
        indexedAtMs,
        nowMs,
      );
      clearFiles.run(source, sessionId);
      for (const file of analysis.contextFiles) {
        putFile.run(
          source,
          sessionId,
          file.filePath ?? file.name,
          file.name,
          file.category,
          file.status,
          file.estTokens,
        );
      }
      // Rewritten wholesale for the same reason as the context files: a signal
      // absent from the re-analysis must leave the themes, not linger in them.
      clearFindings.run(source, sessionId);
      for (const finding of analysis.findings) {
        putFinding.run(source, sessionId, finding.id, finding.severity, finding.count);
      }
    })();
  }

  /**
   * Forget every deviation verdict, keeping the context-file rows.
   *
   * Deviation counts depend on the duration threshold, so changing it makes them
   * all wrong at once. Dropping the analysis rows marks those sessions stale and
   * the background pass recomputes them. Retrospective verdicts ride along
   * deliberately: a "Ran long" deviation can feed a verdict, so a threshold
   * change re-judges those too.
   */
  clearDeviations(): void {
    // Findings ride along: they were projected from the same retrospectives the
    // re-analysis is about to re-judge, so stale ones must not outlive the rows.
    this.db.exec('DELETE FROM session_analysis; DELETE FROM session_findings;');
  }

  // -- session retrospectives ------------------------------------------------

  /**
   * The Retro view's ranking: every judged session, worst verdict tier first
   * (abandoned, struggled, bumpy, smooth), most recent first within a tier.
   *
   * Only rows with a verdict qualify — NULL means "not judged", which belongs
   * in neither tier. The repository list ships WITH the rows because both come
   * from the same scan; a second call could disagree with what is on screen.
   */
  retro(
    params: { repository?: string } = {},
    hiddenKeys: readonly string[] = [],
  ): { rows: RetroListRow[]; repositories: string[] } {
    const clauses = ['a.verdict IS NOT NULL'];
    const args: unknown[] = [];
    if (params.repository !== undefined && params.repository.length > 0) {
      clauses.push('s.repository = ?');
      args.push(params.repository);
    }
    if (hiddenKeys.length > 0) {
      clauses.push(`s.source || ':' || s.session_id NOT IN (${hiddenKeys.map(() => '?').join(', ')})`);
      args.push(...hiddenKeys);
    }
    const where = `WHERE ${clauses.join(' AND ')}`;
    const from =
      'FROM session_analysis a JOIN sessions s ON s.source = a.source AND s.session_id = a.session_id';

    const stored = this.db
      .prepare(
        `SELECT s.source AS source, s.session_id AS sessionId, s.repository AS repository,
                s.title AS title, s.ended_at_ms AS endedAtMs,
                a.verdict AS verdict, a.outcome AS outcome,
                a.correction_turns AS correctionTurns,
                a.repeated_prompt_turns AS repeatedPromptTurns,
                a.interruptions AS interruptions,
                a.max_error_streak AS maxErrorStreak,
                a.churn_ratio_pct AS churnRatioPct,
                a.compactions AS compactions,
                a.tip_count AS tipCount
           ${from} ${where}
          ORDER BY CASE a.verdict
                     WHEN 'abandoned' THEN 0
                     WHEN 'struggled' THEN 1
                     WHEN 'bumpy' THEN 2
                     ELSE 3
                   END ASC,
                   s.ended_at_ms DESC
          LIMIT ?`,
      )
      .all(...args, RETRO_ROW_LIMIT) as (Omit<RetroListRow, 'title' | 'verdict'> & {
      title: string | null;
      verdict: string;
    })[];

    const rows: RetroListRow[] = [];
    for (const row of stored) {
      const verdict = toVerdict(row.verdict);
      if (verdict === undefined) {
        continue;
      }
      rows.push({ ...row, verdict, title: row.title ?? undefined });
    }

    const repositories = (
      this.db
        .prepare(`SELECT DISTINCT s.repository AS repository ${from} ${where} ORDER BY 1`)
        .all(...args) as { repository: string }[]
    ).map((r) => r.repository);

    return { rows, repositories };
  }

  // -- context hotspots ------------------------------------------------------

  /**
   * The Context Hotspots ranking: one row per customization file, folded over
   * every analyzed session that had it in context.
   *
   * Ranked busiest-first — contributing sessions, then heaviest, then path —
   * matching core's `buildContextHotspots`. `name` and `category` are taken with
   * MIN only to be deterministic: a file's classification comes from where it was
   * discovered, which does not vary between sessions in practice.
   */
  hotspots(
    params: { repository?: string; endedAfterMs?: number } = {},
    hiddenKeys: readonly string[] = [],
  ): HotspotRow[] {
    const { where, args } = hotspotFilter(params, hiddenKeys);
    return this.db
      .prepare(
        `SELECT cf.file AS file,
                MIN(cf.name) AS name,
                MIN(cf.category) AS category,
                COUNT(*) AS sessionCount,
                COALESCE(SUM(CASE WHEN cf.status = 'applied' THEN 1 ELSE 0 END), 0) AS appliedCount,
                COALESCE(SUM(CASE WHEN cf.status = 'skipped' THEN 1 ELSE 0 END), 0) AS skippedCount,
                COALESCE(SUM(CASE WHEN cf.status = 'read' THEN 1 ELSE 0 END), 0) AS readCount,
                COALESCE(MAX(cf.est_tokens), 0) AS estTokensMax,
                COALESCE(SUM(CASE WHEN COALESCE(a.error_count, 0) > 0 THEN 1 ELSE 0 END), 0) AS errorSessions,
                COALESCE(SUM(CASE WHEN COALESCE(a.deviation_count, 0) > 0 THEN 1 ELSE 0 END), 0) AS deviationSessions,
                COALESCE(MAX(s.ended_at_ms), 0) AS lastSeenMs
           FROM context_files cf
           JOIN sessions s ON s.source = cf.source AND s.session_id = cf.session_id
           LEFT JOIN session_analysis a ON a.source = cf.source AND a.session_id = cf.session_id
           ${where}
          GROUP BY cf.file
          ORDER BY sessionCount DESC, estTokensMax DESC, cf.file ASC
          LIMIT ?`,
      )
      .all(...args, HOTSPOT_ROW_LIMIT) as HotspotRow[];
  }

  /** The sessions behind one hotspot row, newest first. */
  hotspotSessions(
    file: string,
    params: { repository?: string } = {},
    hiddenKeys: readonly string[] = [],
    limit = HOTSPOT_SESSION_ROW_LIMIT,
  ): HotspotSessionRow[] {
    const { where, args } = hotspotFilter(params, hiddenKeys, file);
    const rows = this.db
      .prepare(
        `SELECT cf.source AS source, cf.session_id AS sessionId, s.repository AS repository,
                s.title AS title, s.ended_at_ms AS endedAtMs, cf.status AS status,
                cf.est_tokens AS estTokens,
                COALESCE(a.error_count, 0) AS errors,
                COALESCE(a.deviation_count, 0) AS deviations
           FROM context_files cf
           JOIN sessions s ON s.source = cf.source AND s.session_id = cf.session_id
           LEFT JOIN session_analysis a ON a.source = cf.source AND a.session_id = cf.session_id
           ${where}
          ORDER BY s.ended_at_ms DESC
          LIMIT ?`,
      )
      .all(...args, limit) as StoredHotspotSession[];

    return rows.map((row) => ({
      source: row.source,
      sessionId: row.sessionId,
      repository: row.repository,
      title: row.title ?? undefined,
      endedAtMs: row.endedAtMs,
      status: row.status,
      estTokens: row.estTokens,
      hadError: row.errors > 0,
      hadDeviation: row.deviations > 0,
    }));
  }

  /** Repositories the ranking can be narrowed to — only ones with analysis behind them. */
  hotspotRepositories(hiddenKeys: readonly string[] = []): string[] {
    const { where, args } = hotspotFilter({}, hiddenKeys);
    const rows = this.db
      .prepare(
        `SELECT DISTINCT s.repository AS repository
           FROM context_files cf
           JOIN sessions s ON s.source = cf.source AND s.session_id = cf.session_id
           ${where}
          ORDER BY s.repository ASC`,
      )
      .all(...args) as { repository: string }[];
    return rows.map((r) => r.repository);
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

  /**
   * Local working directories known to belong to a repository, newest
   * resolution first — the reverse of {@link getCachedRepository}, for features
   * that need a checkout on disk (the improvement plan's context-file scan).
   */
  cwdsForRepository(repository: string, limit = 20): { cwd: string; resolvedAtMs: number }[] {
    return this.db
      .prepare(
        `SELECT cwd, resolved_at_ms AS resolvedAtMs FROM repo_cache
          WHERE repository = ? ORDER BY resolved_at_ms DESC LIMIT ?`,
      )
      .all(repository, limit) as { cwd: string; resolvedAtMs: number }[];
  }

  /**
   * Absolute context-file paths seen in a repository's sessions, newest first —
   * the fallback root hint for repositories whose sessions carried no cwd
   * (Copilot sessions resolve their repository another way).
   */
  contextFilePathsForRepository(repository: string, limit = 50): string[] {
    const rows = this.db
      .prepare(
        `SELECT cf.file AS file, MAX(s.ended_at_ms) AS newest
           FROM context_files cf
           JOIN sessions s ON s.source = cf.source AND s.session_id = cf.session_id
          WHERE s.repository = ?
          GROUP BY cf.file
          ORDER BY newest DESC
          LIMIT ?`,
      )
      .all(repository, limit) as { file: string }[];
    return rows.map((row) => row.file);
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

/** One repository's card before the live counts are folded in. */
export interface RepositoryCardRow {
  repository: string;
  sessions: number;
  lastActivityMs: number;
  bySource: { source: string; sessions: number }[];
  verdicts: Record<RetroVerdict | 'unjudged', number>;
  costMicros: number;
  costSessions: number;
}

/** One judged session's retrospective counts plus the finding ids it raised. */
export interface RepoSessionFindingsRow {
  source: string;
  sessionId: string;
  verdict: RetroVerdict;
  outcome: string;
  correctionTurns: number;
  repeatedPromptTurns: number;
  interruptions: number;
  errorStreaks: number;
  maxErrorStreak: number;
  longTailTurns: number;
  compactions: number;
  churnRatioPct: number;
  planModeUsed: boolean;
  firstPromptRating?: string;
  tipCount: number;
  signalIds: string[];
}

/** One (session, context file) row as the team shard collector reads it. */
export interface ContextFileObservationRow {
  source: string;
  sessionId: string;
  repository: string;
  startedAtMs: number;
  /** Absolute path as the analyzer stored it. */
  file: string;
  category: string;
  status: string;
  estTokens: number;
  errorCount: number;
  deviationCount: number;
}

function emptyVerdicts(): Record<RetroVerdict | 'unjudged', number> {
  return { smooth: 0, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0 };
}

/**
 * The WHERE clause every repository-hub query shares, over the `s` sessions
 * alias: one repository (or all), an end-time range, and the hidden set.
 * Always yields a clause so callers can append `AND …` safely.
 */
function repoScope(
  repository: string | undefined,
  cutoffMs: number,
  untilMs: number | undefined,
  hiddenKeys: readonly string[],
): { where: string; args: unknown[] } {
  const clauses = ['s.ended_at_ms > 0'];
  const args: unknown[] = [];
  if (repository !== undefined) {
    clauses.push('s.repository = ?');
    args.push(repository);
  }
  if (cutoffMs > 0) {
    clauses.push('s.ended_at_ms >= ?');
    args.push(cutoffMs);
  }
  if (untilMs !== undefined) {
    clauses.push('s.ended_at_ms < ?');
    args.push(untilMs);
  }
  if (hiddenKeys.length > 0) {
    clauses.push(`s.source || ':' || s.session_id NOT IN (${hiddenKeys.map(() => '?').join(', ')})`);
    args.push(...hiddenKeys);
  }
  return { where: `WHERE ${clauses.join(' AND ')}`, args };
}

/** Hard ceiling so a bad `limit` cannot ask for the whole table. */
function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return 200;
  }
  return Math.min(Math.floor(limit), 2000);
}

function buildFilter(
  params: ListSessionsParams,
  /** `source:sessionId` keys the user has taken out of their list. */
  hiddenKeys: readonly string[] = [],
  /** Key sets the index cannot derive on its own — they live in JSON stores. */
  overlay: SessionKeyOverlay = {},
): { where: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];
  const key = `s.source || ':' || s.session_id`;

  // Hidden sessions are excluded in SQL rather than after the query, so a
  // page of results is not silently short once some of it is filtered away.
  if (hiddenKeys.length > 0) {
    const placeholders = hiddenKeys.map(() => '?').join(', ');
    clauses.push(`${key} ${params.hidden === true ? 'IN' : 'NOT IN'} (${placeholders})`);
    args.push(...hiddenKeys);
  } else if (params.hidden === true) {
    // Asking for hidden sessions when none are hidden must return nothing,
    // not everything.
    clauses.push('1 = 0');
  }
  if (params.source !== undefined && params.source.length > 0) {
    clauses.push('s.source = ?');
    args.push(params.source);
  }
  if (params.repository !== undefined && params.repository.length > 0) {
    clauses.push('s.repository = ?');
    args.push(params.repository);
  }
  // Inclusive, and over the END time — the column this list is ordered by and
  // the one the overview buckets its day columns by, so clicking a day opens
  // exactly the sessions that column counted.
  if (params.endedAfterMs !== undefined) {
    clauses.push('s.ended_at_ms >= ?');
    args.push(params.endedAfterMs);
  }
  if (params.endedBeforeMs !== undefined) {
    clauses.push('s.ended_at_ms <= ?');
    args.push(params.endedBeforeMs);
  }
  // Tags live outside the index, so the caller resolves the tag to session keys
  // and passes them here. An EMPTY set means the tag exists on nothing: that
  // has to select nothing, exactly as the hidden filter above does. An
  // UNRESOLVED tag (keys absent) fails closed for the same reason — returning
  // the whole list would read as the tag matching everything.
  if (params.tag !== undefined && params.tag.length > 0 && overlay.restrictKeys === undefined) {
    clauses.push('1 = 0');
  } else if (overlay.restrictKeys !== undefined) {
    if (overlay.restrictKeys.length === 0) {
      clauses.push('1 = 0');
    } else {
      clauses.push(`${key} IN (${overlay.restrictKeys.map(() => '?').join(', ')})`);
      args.push(...overlay.restrictKeys);
    }
  }
  // A session with no analysis row yet is unread, not clean, so the chip shows
  // only what the analysis actually flagged.
  if (params.deviations === true) {
    clauses.push('COALESCE(a.deviation_count, 0) > 0');
  }
  // Same honesty rule: a NULL verdict is "not judged", which must never pass
  // a friction filter as if it were smooth — or as if it were struggled.
  if (params.friction === true) {
    clauses.push(`a.verdict IN ('struggled', 'abandoned')`);
  }
  if (params.verdict !== undefined) {
    clauses.push('a.verdict = ?');
    args.push(params.verdict);
  }
  // A theme drill-down: sessions whose retrospective raised this signal beyond
  // info severity — the same predicate the Dashboard's themes card counts by.
  if (params.signal !== undefined && params.signal.length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM session_findings f
                WHERE f.source = s.source AND f.session_id = s.session_id
                  AND f.signal_id = ? AND f.severity <> 'info')`,
    );
    args.push(params.signal);
  }
  const query = params.query?.trim();
  if (query !== undefined && query.length > 0) {
    // ESCAPE is required for the backslashes below to mean anything: without it
    // SQLite treats them as literal characters and a search for "100%" matches
    // everything instead of the one session that says it.
    const parts = [
      `s.title LIKE ? ESCAPE '\\'`,
      `s.repository LIKE ? ESCAPE '\\'`,
      `s.session_id LIKE ? ESCAPE '\\'`,
    ];
    const like = `%${query.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(like, like, like);
    // The index stores ORIGINAL titles, so a session found only by the name the
    // user gave it is matched by key instead. It has to be OR-ed into the same
    // predicate rather than unioned in afterwards: appending rows after SQL's
    // LIMIT would make the second page skip and duplicate.
    const renameKeys = overlay.renameKeys ?? [];
    if (renameKeys.length > 0) {
      parts.push(`${key} IN (${renameKeys.map(() => '?').join(', ')})`);
      args.push(...renameKeys);
    }
    clauses.push(`(${parts.join(' OR ')})`);
  }
  return { where: clauses.length === 0 ? '' : `WHERE ${clauses.join(' AND ')}`, args };
}
/**
 * The WHERE clause shared by every hotspots query, so the ranking, the expanded
 * sessions, and the repository list can never disagree about what they cover.
 * Hidden sessions are excluded here for the same reason the overview excludes
 * them: a count that includes what the user removed reads as a bug.
 */
function hotspotFilter(
  params: { repository?: string; endedAfterMs?: number },
  hiddenKeys: readonly string[],
  file?: string,
): { where: string; args: unknown[] } {
  const clauses: string[] = [];
  const args: unknown[] = [];

  if (file !== undefined) {
    clauses.push('cf.file = ?');
    args.push(file);
  }
  if (params.repository !== undefined && params.repository.length > 0) {
    clauses.push('s.repository = ?');
    args.push(params.repository);
  }
  // The Dashboard's windowed card; the Hotspots view passes nothing and keeps
  // its all-time ranking.
  if (params.endedAfterMs !== undefined && params.endedAfterMs > 0) {
    clauses.push('s.ended_at_ms >= ?');
    args.push(params.endedAfterMs);
  }
  if (hiddenKeys.length > 0) {
    clauses.push(
      `cf.source || ':' || cf.session_id NOT IN (${hiddenKeys.map(() => '?').join(', ')})`,
    );
    args.push(...hiddenKeys);
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
    deviationCount: row.deviation_count ?? undefined,
    verdict: toVerdict(row.verdict),
    indexedAtMs: row.indexed_at_ms,
    pending: row.pending === 1 ? true : undefined,
  };
}

/** Narrow a stored verdict to the typed union; anything else reads unjudged. */
function toVerdict(raw: string | null | undefined): RetroVerdict | undefined {
  return raw === 'smooth' || raw === 'bumpy' || raw === 'struggled' || raw === 'abandoned'
    ? raw
    : undefined;
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
