import { Database } from 'node-sqlite3-wasm';
import { SpanRows } from './otlpToRows';

/**
 * The extension's OWN telemetry store, written from the OTLP receiver.
 *
 * It mirrors Copilot's `agent-traces.db` schema EXACTLY (verified DDL), so the
 * entire existing read layer ({@link ../telemetry/database.TelemetryDatabase} +
 * the detail/deviation/aggregation code) works against it unchanged — the
 * extension simply becomes the sink instead of polling Copilot's DB.
 *
 * Opened READ-WRITE (rollback-journal, not WAL) and owned by a single process,
 * so the bundled WASM driver can both write here and let the snapshot reader copy
 * it. Writes are synchronous transactions; because JS is single-threaded they can
 * never interleave with a snapshot copy, so the file is always read-consistent.
 */

/** Schema version this store writes (must be in `TelemetryDatabase`'s supported set). */
const SCHEMA_VERSION = 1;

/** The columns of the `spans` table, in the order {@link SpanRows} carries them. */
export const SPAN_COLUMNS = [
  'span_id', 'trace_id', 'parent_span_id', 'name', 'start_time_ms', 'end_time_ms',
  'status_code', 'status_message', 'operation_name', 'provider_name', 'agent_name',
  'conversation_id', 'request_model', 'response_model', 'input_tokens', 'output_tokens',
  'cached_tokens', 'reasoning_tokens', 'tool_name', 'tool_call_id', 'tool_type',
  'chat_session_id', 'turn_index', 'ttft_ms',
] as const;

/** Copilot's `agent-traces.db` schema (idempotent), replicated exactly. */
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS spans (
  span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT,
  name TEXT NOT NULL, start_time_ms INTEGER NOT NULL, end_time_ms INTEGER NOT NULL,
  status_code INTEGER NOT NULL DEFAULT 0, status_message TEXT,
  operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
  request_model TEXT, response_model TEXT,
  input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
  tool_name TEXT, tool_call_id TEXT, tool_type TEXT,
  chat_session_id TEXT, turn_index INTEGER, ttft_ms REAL
);
CREATE TABLE IF NOT EXISTS span_attributes (
  span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
  key TEXT NOT NULL, value TEXT,
  PRIMARY KEY (span_id, key)
);
CREATE TABLE IF NOT EXISTS span_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
  name TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, attributes TEXT
);
CREATE INDEX IF NOT EXISTS idx_spans_start_time ON spans(start_time_ms);
CREATE INDEX IF NOT EXISTS idx_spans_trace ON spans(trace_id);
CREATE INDEX IF NOT EXISTS idx_spans_conversation ON spans(conversation_id);
CREATE INDEX IF NOT EXISTS idx_spans_chat_session ON spans(chat_session_id);
CREATE INDEX IF NOT EXISTS idx_spans_operation ON spans(operation_name);
CREATE INDEX IF NOT EXISTS idx_span_events_span ON span_events(span_id);
CREATE VIEW IF NOT EXISTS sessions AS
  SELECT
    COALESCE(conversation_id, chat_session_id) AS session_id,
    agent_name,
    response_model AS model,
    MIN(start_time_ms) AS started_at,
    MAX(end_time_ms) AS ended_at,
    MAX(end_time_ms) - MIN(start_time_ms) AS duration_ms,
    COUNT(*) AS span_count,
    SUM(CASE WHEN operation_name = 'chat' THEN 1 ELSE 0 END) AS llm_calls,
    SUM(CASE WHEN operation_name = 'execute_tool' THEN 1 ELSE 0 END) AS tool_calls,
    SUM(CASE WHEN operation_name = 'chat' THEN input_tokens ELSE 0 END) AS total_input_tokens,
    SUM(CASE WHEN operation_name = 'chat' THEN output_tokens ELSE 0 END) AS total_output_tokens,
    SUM(CASE WHEN operation_name = 'chat' THEN cached_tokens ELSE 0 END) AS total_cached_tokens
  FROM spans
  WHERE COALESCE(conversation_id, chat_session_id) IS NOT NULL
  GROUP BY COALESCE(conversation_id, chat_session_id);
`;

const INSERT_SPAN_SQL =
  `INSERT OR REPLACE INTO spans (${SPAN_COLUMNS.join(', ')}) ` +
  `VALUES (${SPAN_COLUMNS.map(() => '?').join(', ')})`;
const INSERT_ATTR_SQL = 'INSERT OR REPLACE INTO span_attributes (span_id, key, value) VALUES (?, ?, ?)';

/**
 * Sidecar table (NOT part of Copilot's schema) tracking, per swept source DB,
 * the high-water `end_time_ms` already copied into this store and the source's
 * last-seen mtime for a cheap skip-if-unchanged. Used only by the
 * {@link ./copilotArchiver.CopilotArchiver}; empty (and ignored) in the live
 * ingest DB. The read layer validates only `spans`/`span_attributes`/`sessions`,
 * so this extra table is invisible to it.
 */
const WATERMARK_DDL = `
CREATE TABLE IF NOT EXISTS archive_watermark (
  source_path TEXT PRIMARY KEY,
  last_end_ms INTEGER NOT NULL,
  source_mtime_ms REAL,
  updated_ms INTEGER NOT NULL
);`;

const UPSERT_WATERMARK_SQL =
  'INSERT OR REPLACE INTO archive_watermark ' +
  '(source_path, last_end_ms, source_mtime_ms, updated_ms) VALUES (?, ?, ?, ?)';

/** A sweep watermark for one source DB (see {@link WATERMARK_DDL}). */
export interface SweepWatermark {
  /** Highest `end_time_ms` already ingested from the source (minus a grace overlap). */
  lastEndMs: number;
  /** The source's mtime at the last sweep, or `null` if it was unavailable. */
  sourceMtimeMs: number | null;
}

export class IngestStore {
  private readonly db: Database;

  constructor(private readonly path: string) {
    this.db = new Database(path);
    // Enable FK cascade so pruning spans also removes their attributes/events.
    this.db.exec('PRAGMA foreign_keys = ON;');
    // Defense-in-depth for the shared home archive: if two writers ever race the
    // single-writer lease (see {@link ./writerLease}), a brief file lock retries
    // rather than failing outright. Harmless for the single-process live path.
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA_DDL);
    this.db.exec(WATERMARK_DDL);
    if (this.getRow<{ version: number }>('SELECT version FROM schema_version LIMIT 1') === undefined) {
      this.db.run('INSERT INTO schema_version (version) VALUES (?)', [SCHEMA_VERSION]);
    }
  }

  /** Absolute path of the backing DB file (used as a TelemetryService source). */
  get dbPath(): string {
    return this.path;
  }

  /**
   * Upsert a batch of spans + their attributes in a single transaction. Idempotent
   * by `span_id` (a re-exported span replaces its prior row), so duplicate OTLP
   * deliveries never double-count. Returns the number of spans written.
   */
  writeSpans(rows: SpanRows): number {
    if (rows.spans.length === 0) {
      return 0;
    }
    this.db.exec('BEGIN');
    try {
      for (const s of rows.spans) {
        this.db.run(INSERT_SPAN_SQL, [
          s.span_id, s.trace_id, s.parent_span_id, s.name, s.start_time_ms, s.end_time_ms,
          s.status_code, s.status_message, s.operation_name, s.provider_name, s.agent_name,
          s.conversation_id, s.request_model, s.response_model, s.input_tokens, s.output_tokens,
          s.cached_tokens, s.reasoning_tokens, s.tool_name, s.tool_call_id, s.tool_type,
          s.chat_session_id, s.turn_index, s.ttft_ms,
        ]);
      }
      for (const a of rows.attributes) {
        this.db.run(INSERT_ATTR_SQL, [a.span_id, a.key, a.value]);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // ignore: rollback best-effort
      }
      throw err;
    }
    return rows.spans.length;
  }

  /**
   * Delete spans whose start time is older than `nowMs - maxAgeMs` (FK cascade
   * removes their attributes + events), keeping the store small so the snapshot
   * copy stays cheap. Returns the number of spans removed.
   */
  prune(maxAgeMs: number, nowMs: number): number {
    const cutoff = nowMs - maxAgeMs;
    this.db.run('DELETE FROM spans WHERE start_time_ms < ?', [cutoff]);
    return this.db.get('SELECT changes() AS n')?.n as number ?? 0;
  }

  /** Read the sweep watermark for a source DB, or `undefined` if never swept. */
  readWatermark(sourcePath: string): SweepWatermark | undefined {
    const row = this.db.get(
      'SELECT last_end_ms, source_mtime_ms FROM archive_watermark WHERE source_path = ?',
      [sourcePath],
    ) as { last_end_ms: number; source_mtime_ms: number | null } | null;
    if (row === null) {
      return undefined;
    }
    return { lastEndMs: row.last_end_ms, sourceMtimeMs: row.source_mtime_ms };
  }

  /** Upsert the sweep watermark for a source DB (keyed by its path). */
  writeWatermark(sourcePath: string, lastEndMs: number, sourceMtimeMs: number | null, nowMs: number): void {
    this.db.run(UPSERT_WATERMARK_SQL, [sourcePath, lastEndMs, sourceMtimeMs, nowMs]);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      // best-effort
    }
  }

  private getRow<T>(sql: string): T | undefined {
    const row = this.db.get(sql);
    return row === null ? undefined : (row as unknown as T);
  }
}
