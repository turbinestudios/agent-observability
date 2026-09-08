import { Database } from 'node-sqlite3-wasm';
import type { ReadBindings, ReadonlySqliteConnection } from './readBackend';
import { RepositoryResolver } from './repositoryResolver';
import { UNKNOWN_REPOSITORY } from './repositoryUrl';
import { AggregationRow } from '../aggregate/aggregator';
import { mapToolName } from '../aggregate/builtinTools';
import { sanitizeModelId } from '../aggregate/modelId';
import {
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionSummary,
  SessionDetail,
  SessionTreeStats,
  SessionModelUsage,
  SessionAgentUsage,
  SessionTimelineEntry,
  SessionTurn,
  SessionModelTurnPoint,
  AgentMode,
  agentUsageKey,
  mapAgentMode,
  statusToSuccess,
} from './models';
import {
  CHAT_SESSION_CANDIDATES_SQL,
  CONVERSATION_ONLY_CANDIDATES_SQL,
  SESSION_KEY_EXPR,
  UUID_RE,
  startedSessionSet,
  suggestionOnlySql,
} from './sessionFilter';
import { extractResponseText } from './responseText';
import { countWrittenLines, WriteLineDelta } from './locAnalysis';
import { timeBucket } from './timeBucket';
import { SessionTitleInfo } from './sessionTitles';
import { READ_INDEX_DDL } from './schemaIndexes';

/** Span attribute key holding a tool call's raw arguments (file path + content/diff). */
const TOOL_ARGUMENTS_KEY = 'gen_ai.tool.call.arguments';

/** Schema versions this reader understands. */
export const SUPPORTED_SCHEMA_VERSIONS: ReadonlySet<number> = new Set([1]);

/** Thrown when the opened DB is not a shape this reader supports. */
export class SchemaMismatchError extends Error {
  constructor(
    message: string,
    /** Machine-readable detail for the service layer / diagnostics. */
    readonly detail: string,
  ) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

/** Default agent name when a span carries none. */
const DEFAULT_AGENT = 'copilot';

/** Shared empty exclusion set so the no-filter default never allocates. */
const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

/** Shared empty set for a session-key lookup that does not need to be queried. */
const NO_SESSIONS: ReadonlySet<string> = new Set();

/**
 * Defensive cap on the breadth-first agent-tree walk in {@link
 * TelemetryDatabase.sessionTreeIds}. Each hop expands the frontier by one edge in
 * the conversation/chat-session id graph; real agent runs nest only a few levels,
 * so this is a safety backstop against a pathological cycle, not a real limit.
 */
const MAX_TREE_HOPS = 64;

/** All-zero {@link SessionTreeStats}, used as a belt-and-braces fallback. */
const EMPTY_TREE_STATS: SessionTreeStats = {
  modelTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  errorCount: 0,
  aiuNano: 0,
  linesOfCode: 0,
  linesOfDoc: 0,
  linesOfCodeRemoved: 0,
  linesOfDocRemoved: 0,
};

/**
 * Create the read layer's supporting indexes on a SNAPSHOT COPY, before it is
 * opened read-only.
 *
 * The copy is this process's private temp file (see {@link ./snapshot.createReadonlySnapshot})
 * and is deleted with the handle, so writing to it mutates nobody's data — the
 * invariant that matters is on the SOURCE, which this never opens. It exists for
 * the source we are not allowed to write at all: Copilot's own
 * `agent-traces.db`, which a machine with no archive reads directly.
 *
 * Where the source IS ours the index is already present — {@link ../otel/ingestStore.IngestStore}
 * creates it on every open — the copy inherits it, and this costs one
 * `sqlite_master` lookup.
 *
 * Best-effort by design: an unindexed snapshot still answers every query, just
 * more slowly, so a failure here must never fail the open.
 */
export function ensureSnapshotIndexes(snapshotDbPath: string): void {
  let db: Database | undefined;
  try {
    db = new Database(snapshotDbPath, { fileMustExist: true });
    db.exec(READ_INDEX_DDL);
  } catch {
    // Slower queries, not a broken view. Deliberately swallowed.
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed, or never opened.
    }
  }
}

/**
 * Shared read-only queries over a consistent view of `agent-traces.db`.
 *
 * Opened with `{ readonly: true, fileMustExist: true }` against a temp COPY
 * (see {@link createReadonlySnapshot}) so it can never mutate the real DB.
 * Hosts may instead supply a read-only connection scoped to a read transaction
 * via fromConnection. Validates the schema and exposes safe-metadata queries; the
 * repository resolver guarantees every Session/Repository carries a sanitized
 * repository.
 */
export class TelemetryDatabase {
  private readonly db: ReadonlySqliteConnection;
  private resolverCache: RepositoryResolver | undefined;
  private spansColumnsCache: ReadonlySet<string> | undefined;
  private startedSessionsCache: ReadonlySet<string> | undefined;
  private modelCache: Map<string, string> | undefined;
  private modesCache: Map<string, AgentMode[]> | undefined;
  // Only ONE tree/classification retained, not an unbounded per-session cache.
  // Handles describe immutable snapshots/transactions; native handles end with
  // each request. Tool arguments are discarded; only numeric deltas survive.
  private treeCache: { root: string; ids: string[] } | undefined;
  private writesCache: {
    root: string; extensions: string;
    rows: Array<{ startMs: number; delta: WriteLineDelta }>;
  } | undefined;
  /** Scoped repository fallback threaded into the {@link RepositoryResolver}. */
  private repositoryFallback: ((sessionId: string) => string | undefined) | undefined;

  private constructor(db: ReadonlySqliteConnection) {
    this.db = db;
  }

  /**
   * Run a single-row query via the auto-finalizing convenience method and
   * normalize node-sqlite3-wasm's `null` (no row) to `undefined` so callers can
   * keep using `=== undefined` checks. `db.get`/`db.all` finalize the internal
   * prepared statement for us — unlike a raw `db.prepare(...)`, which would leak
   * WASM memory since `db.close()` does not finalize pending statements.
   */
  private getRow<T>(sql: string, params?: ReadBindings): T | undefined {
    const row = this.db.get(sql, params);
    return row === null || row === undefined ? undefined : (row as T);
  }

  /** Run a multi-row query via the auto-finalizing convenience method. */
  private allRows<T>(sql: string, params?: ReadBindings): T[] {
    return this.db.all(sql, params) as unknown as T[];
  }

  /**
   * Open the snapshot copy read-only and validate its schema.
   *
   * @throws SchemaMismatchError when the file is not a supported telemetry DB.
   * @throws the underlying node-sqlite3-wasm error (e.g. ENOENT) when the file is
   *   missing or unreadable — the service layer classifies these.
   */
  static open(snapshotDbPath: string): TelemetryDatabase {
    const db = new Database(snapshotDbPath, { readOnly: true, fileMustExist: true });
    return TelemetryDatabase.fromConnection(db);
  }

  /**
   * Take ownership of a host-opened READ-ONLY connection. The host must pin a
   * consistent view for this instance's lifetime: its caches assume immutable
   * data. A failed schema check closes the connection before propagating.
   */
  static fromConnection(db: ReadonlySqliteConnection): TelemetryDatabase {
    const instance = new TelemetryDatabase(db);
    try {
      instance.validateSchema();
    } catch (err) {
      instance.close();
      throw err;
    }
    return instance;
  }

  /** Close the underlying connection. Guarded so a double close never throws. */
  close(): void {
    try {
      this.db.close();
    } catch {
      // Connection may already be closed; ignore.
    }
  }

  /**
   * Assert the DB is a supported telemetry shape:
   * - `schema_version` row ∈ {@link SUPPORTED_SCHEMA_VERSIONS},
   * - `spans` + `span_attributes` tables and the `sessions` view exist,
   * - required `spans` columns are present.
   *
   * @throws {@link SchemaMismatchError} with detail otherwise.
   */
  validateSchema(): void {
    // schema_version table + value.
    let version: number;
    try {
      const row = this.getRow<{ version: number }>('SELECT version FROM schema_version LIMIT 1');
      if (row === undefined || typeof row.version !== 'number') {
        throw new SchemaMismatchError(
          'Telemetry database has no schema_version row.',
          'missing-schema-version-row',
        );
      }
      version = row.version;
    } catch (err) {
      if (err instanceof SchemaMismatchError) {
        throw err;
      }
      throw new SchemaMismatchError(
        'Telemetry database is missing the schema_version table.',
        'missing-schema-version-table',
      );
    }

    if (!SUPPORTED_SCHEMA_VERSIONS.has(version)) {
      throw new SchemaMismatchError(
        `Unsupported telemetry schema version ${version}.`,
        `unsupported-schema-version:${version}`,
      );
    }

    // Required objects.
    this.assertObject('spans', 'table');
    this.assertObject('span_attributes', 'table');
    this.assertObject('sessions', 'view');

    // Required spans columns.
    const required = [
      'span_id',
      'trace_id',
      'start_time_ms',
      'end_time_ms',
      'status_code',
      'operation_name',
      'agent_name',
      'conversation_id',
      'chat_session_id',
      'request_model',
      'response_model',
      'input_tokens',
      'output_tokens',
      'cached_tokens',
      'tool_name',
    ];
    const columns = new Set(
      this.allRows<{ name: string }>("PRAGMA table_info('spans')").map((c) => c.name),
    );
    const missing = required.filter((c) => !columns.has(c));
    if (missing.length > 0) {
      throw new SchemaMismatchError(
        `Telemetry database 'spans' table is missing columns: ${missing.join(', ')}.`,
        `missing-columns:${missing.join(',')}`,
      );
    }
  }

  /** Assert a table/view named `name` of `kind` exists in sqlite_master. */
  private assertObject(name: string, kind: 'table' | 'view'): void {
    const row = this.getRow<{ type: string }>(
      'SELECT type FROM sqlite_master WHERE name = ? LIMIT 1',
      [name],
    );
    if (row === undefined) {
      throw new SchemaMismatchError(
        `Telemetry database is missing the '${name}' ${kind}.`,
        `missing-${kind}:${name}`,
      );
    }
    if (row.type !== kind) {
      throw new SchemaMismatchError(
        `Telemetry database object '${name}' is a ${row.type}, expected a ${kind}.`,
        `wrong-type:${name}:${row.type}`,
      );
    }
  }

  /** Lazily build (and cache) the per-session repository resolver. */
  private resolver(): RepositoryResolver {
    if (this.resolverCache === undefined) {
      this.resolverCache = RepositoryResolver.fromDatabase(this.db);
    }
    // Re-apply each call so a fallback set after the resolver was first built
    // (the workspace context is wired after open) still takes effect.
    this.resolverCache.setFallback(this.repositoryFallback);
    return this.resolverCache;
  }

  /**
   * Install a SCOPED repository fallback used when a session recorded no remote
   * URL of its own (see {@link RepositoryResolver.setFallback}). The fallback
   * must return values that are ALREADY sanitized — it bypasses the raw-URL
   * chokepoint in {@link RepositoryResolver.fromDatabase}. Pass `undefined` to
   * clear it.
   */
  setRepositoryFallback(fallback: ((sessionId: string) => string | undefined) | undefined): void {
    this.repositoryFallback = fallback;
  }

  /**
   * Cached set of `spans` column names. Used to tolerate optional, provider-
   * specific columns (e.g. `reasoning_tokens`) that a valid schema-v1 DB may
   * omit — selecting a missing column would otherwise throw at query time.
   */
  private spansColumns(): ReadonlySet<string> {
    if (this.spansColumnsCache === undefined) {
      this.spansColumnsCache = new Set(
        this.allRows<{ name: string }>("PRAGMA table_info('spans')").map((c) => c.name),
      );
    }
    return this.spansColumnsCache;
  }

  /**
   * Overview metrics across all spans (optionally since `sinceMs`, inclusive
   * on `start_time_ms`). Distinct repositories/models are computed in JS using
   * the resolver so the sanitized repository (not the raw URL) is the dimension.
   * A non-empty `excludedRepositories` removes those repositories' sessions from
   * every measure (see {@link overviewMetricsExcluding}).
   */
  getOverviewMetrics(sinceMs?: number, excludedRepositories?: ReadonlySet<string>): OverviewMetrics {
    if (excludedRepositories !== undefined && excludedRepositories.size > 0) {
      return this.overviewMetricsExcluding(excludedRepositories, sinceMs);
    }
    const where = sinceMs !== undefined ? 'WHERE start_time_ms >= ?' : '';
    const params = sinceMs !== undefined ? [sinceMs] : [];

    const agg = this.getRow<{
      total_interactions: number;
      total_sessions: number;
      avg_duration_ms: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
      error_count: number | null;
    }>(
      `SELECT
           COUNT(*) AS total_interactions,
           COUNT(DISTINCT COALESCE(conversation_id, chat_session_id)) AS total_sessions,
           AVG(end_time_ms - start_time_ms) AS avg_duration_ms,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(cached_tokens, 0) ELSE 0 END) AS cached_tokens,
           SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
         FROM spans ${where}`,
      params,
    )!;

    const dimensions = this.getOverviewDimensions(sinceMs);

    return {
      totalInteractions: agg.total_interactions,
      totalSessions: agg.total_sessions,
      totalRepositories: dimensions.repositories.length,
      totalModels: dimensions.models.length,
      avgDurationMs: agg.avg_duration_ms === null ? 0 : Math.round(agg.avg_duration_ms),
      // TIN = fresh (non-cache-read) input; cache reads live in `cachedTokens`.
      inputTokens: freshInput(agg.input_tokens ?? 0, agg.cached_tokens ?? 0),
      outputTokens: agg.output_tokens ?? 0,
      cachedTokens: agg.cached_tokens ?? 0,
      errorCount: agg.error_count ?? 0,
    };
  }

  /**
   * {@link getOverviewMetrics} with hidden repositories removed. The repository
   * is not a `spans` column (it is resolved per session key in JS), so the same
   * measures are aggregated GROUPED per session key and only the groups whose
   * resolved repository is not excluded are folded in — the totals equal what
   * the unfiltered query would report over the remaining repositories. Bounded
   * by one row per session, not per span.
   */
  private overviewMetricsExcluding(
    excluded: ReadonlySet<string>,
    sinceMs?: number,
  ): OverviewMetrics {
    const where = sinceMs !== undefined ? 'WHERE start_time_ms >= ?' : '';
    const params = sinceMs !== undefined ? [sinceMs] : [];

    const groups = this.allRows<{
      sk: string | null;
      total_interactions: number;
      duration_sum: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
      error_count: number | null;
    }>(
      `SELECT
           COALESCE(conversation_id, chat_session_id) AS sk,
           COUNT(*) AS total_interactions,
           SUM(end_time_ms - start_time_ms) AS duration_sum,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(cached_tokens, 0) ELSE 0 END) AS cached_tokens,
           SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
         FROM spans ${where}
         GROUP BY COALESCE(conversation_id, chat_session_id)`,
      params,
    );

    const resolver = this.resolver();
    let totalInteractions = 0;
    let totalSessions = 0;
    let durationSum = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;
    let errorCount = 0;
    for (const g of groups) {
      if (excluded.has(resolver.resolve(g.sk))) {
        continue;
      }
      totalInteractions += g.total_interactions;
      // A NULL key group has no session identity: it contributes interactions
      // (like the unfiltered COUNT(*)) but no session (COUNT DISTINCT skips NULL).
      if (g.sk !== null) {
        totalSessions += 1;
      }
      durationSum += g.duration_sum ?? 0;
      inputTokens += g.input_tokens ?? 0;
      outputTokens += g.output_tokens ?? 0;
      cachedTokens += g.cached_tokens ?? 0;
      errorCount += g.error_count ?? 0;
    }

    const dimensions = this.getOverviewDimensions(sinceMs, excluded);

    return {
      totalInteractions,
      totalSessions,
      totalRepositories: dimensions.repositories.length,
      totalModels: dimensions.models.length,
      avgDurationMs: totalInteractions > 0 ? Math.round(durationSum / totalInteractions) : 0,
      // TIN = fresh (non-cache-read) input; cache reads live in `cachedTokens`.
      inputTokens: freshInput(inputTokens, cachedTokens),
      outputTokens,
      cachedTokens,
      errorCount,
    };
  }

  /**
   * The distinct resolved model ids and sanitized repositories across all
   * spans (optionally since `sinceMs`, inclusive on `start_time_ms`), as the
   * NAMES rather than counts — so the service layer can union them across
   * several merged databases without double-counting a model or repository
   * active in more than one environment. Safe metadata only. A non-empty
   * `excludedRepositories` removes those repositories and any model seen ONLY
   * in their sessions.
   */
  getOverviewDimensions(
    sinceMs?: number,
    excludedRepositories?: ReadonlySet<string>,
  ): { models: string[]; repositories: string[] } {
    const excluded = excludedRepositories ?? NO_EXCLUSIONS;
    const where = sinceMs !== undefined ? 'WHERE start_time_ms >= ?' : '';
    const params = sinceMs !== undefined ? [sinceMs] : [];
    const resolver = this.resolver();

    // Distinct models from the typed columns (safe metadata). When repositories
    // are excluded, take DISTINCT (session, model) pairs so a model seen only in
    // hidden sessions does not count.
    const models = new Set<string>();
    if (excluded.size === 0) {
      const modelRows = this.allRows<{ model: string | null }>(
        `SELECT DISTINCT COALESCE(response_model, request_model) AS model
           FROM spans ${where}`,
        params,
      );
      for (const r of modelRows) {
        if (r.model !== null && r.model.length > 0) {
          models.add(r.model);
        }
      }
    } else {
      const modelRows = this.allRows<{ sk: string | null; model: string | null }>(
        `SELECT DISTINCT COALESCE(conversation_id, chat_session_id) AS sk,
                COALESCE(response_model, request_model) AS model
           FROM spans ${where}`,
        params,
      );
      for (const r of modelRows) {
        if (r.model !== null && r.model.length > 0 && !excluded.has(resolver.resolve(r.sk))) {
          models.add(r.model);
        }
      }
    }

    // Distinct sanitized repositories across the session keys in range.
    const sessionRows = this.allRows<{ sk: string | null }>(
      `SELECT DISTINCT COALESCE(conversation_id, chat_session_id) AS sk
         FROM spans ${where}`,
      params,
    );
    const repositories = new Set<string>();
    for (const r of sessionRows) {
      const repository = resolver.resolve(r.sk);
      if (!excluded.has(repository)) {
        repositories.add(repository);
      }
    }

    return { models: [...models], repositories: [...repositories] };
  }

  /**
   * One {@link RepositorySummary} per distinct sanitized repository, ordered by
   * most-recent activity. Aggregates the `sessions` view by resolved repository.
   */
  listRepositories(): RepositorySummary[] {
    const resolver = this.resolver();
    const modelBySession = this.modelBySession();
    const startedSessions = this.startedSessionIds();

    interface Acc {
      repository: string;
      sessionCount: number;
      interactionCount: number;
      models: Set<string>;
      lastActivityMs: number;
    }
    const byRepo = new Map<string, Acc>();

    const rows = this.allRows<{
      session_id: string;
      ended_at: number;
      span_count: number;
    }>(
      `SELECT session_id, ended_at, span_count
         FROM sessions`,
    );

    for (const row of rows) {
      // Only include started sessions (carry at least one span).
      if (!startedSessions.has(row.session_id)) {
        continue;
      }
      const repository = resolver.resolve(row.session_id);
      // Skip the 'unknown' bucket — those sessions are shown ungrouped at root.
      if (repository === UNKNOWN_REPOSITORY) {
        continue;
      }
      let acc = byRepo.get(repository);
      if (acc === undefined) {
        acc = {
          repository,
          sessionCount: 0,
          interactionCount: 0,
          models: new Set<string>(),
          lastActivityMs: 0,
        };
        byRepo.set(repository, acc);
      }
      acc.sessionCount += 1;
      acc.interactionCount += row.span_count;
      const model = modelBySession.get(row.session_id);
      if (model !== undefined) {
        acc.models.add(model);
      }
      if (row.ended_at > acc.lastActivityMs) {
        acc.lastActivityMs = row.ended_at;
      }
    }

    return [...byRepo.values()]
      .map<RepositorySummary>((a) => ({
        repository: a.repository,
        sessionCount: a.sessionCount,
        interactionCount: a.interactionCount,
        models: [...a.models].sort(),
        lastActivityMs: a.lastActivityMs,
      }))
      .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  }

  /**
   * Session summaries, optionally filtered to a single sanitized repository,
   * newest first. `limit` caps the result (applied after repo filtering).
   */
  listSessions(repository?: string, limit?: number): SessionSummary[] {
    const resolver = this.resolver();
    const startedSessions = this.startedSessionIds();

    const rows = this.allRows<{
      session_id: string;
      agent_name: string | null;
      started_at: number;
      ended_at: number;
      duration_ms: number;
      span_count: number;
      llm_calls: number;
      tool_calls: number;
      total_input_tokens: number | null;
      total_output_tokens: number | null;
      total_cached_tokens: number | null;
    }>(
      `SELECT session_id, agent_name, started_at, ended_at, duration_ms,
                span_count, llm_calls, tool_calls,
                total_input_tokens, total_output_tokens, total_cached_tokens
         FROM sessions
         ORDER BY started_at DESC`,
    );

    // Agent modes + representative model per session (consistent resolution).
    const modesBySession = this.agentModesBySession();
    const modelBySession = this.modelBySession();

    const summaries: SessionSummary[] = [];
    for (const row of rows) {
      // Only include started sessions (carry at least one span).
      if (!startedSessions.has(row.session_id)) {
        continue;
      }
      const repo = resolver.resolve(row.session_id);
      if (repository !== undefined && repo !== repository) {
        continue;
      }
      summaries.push({
        sessionId: row.session_id,
        repository: repo,
        startedAtMs: row.started_at,
        endedAtMs: row.ended_at,
        durationMs: row.duration_ms,
        interactionCount: row.span_count,
        llmCalls: row.llm_calls,
        toolCalls: row.tool_calls,
        inputTokens: freshInput(row.total_input_tokens ?? 0, row.total_cached_tokens ?? 0),
        outputTokens: row.total_output_tokens ?? 0,
        cachedTokens: row.total_cached_tokens ?? 0,
        model: modelBySession.get(row.session_id) ?? 'unknown',
        agentModes: [...(modesBySession.get(row.session_id) ?? ['default'])],
      });
      if (limit !== undefined && summaries.length >= limit) {
        break;
      }
    }
    return summaries;
  }

  /**
   * Ordered interactions (by `start_time_ms`) for a single session key. Used by
   * the Phase 3 session-detail view; implemented now. Carries only safe
   * metadata — never raw content.
   */
  getSessionInteractions(sessionKey: string): Interaction[] {
    const resolver = this.resolver();
    const repository = resolver.resolve(sessionKey);

    const rows = this.allRows<{
      span_id: string;
      trace_id: string;
      start_time_ms: number;
      end_time_ms: number;
      status_code: number;
      operation_name: string | null;
      agent_name: string | null;
      request_model: string | null;
      response_model: string | null;
      tool_name: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
    }>(
      `SELECT span_id, trace_id, start_time_ms, end_time_ms, status_code,
                operation_name, agent_name, request_model, response_model,
                tool_name, input_tokens, output_tokens, cached_tokens
         FROM spans
         WHERE COALESCE(conversation_id, chat_session_id) = ?
         ORDER BY start_time_ms ASC, span_id ASC`,
      [sessionKey],
    );

    // Agent mode for this session (one mapped value; first distinct mode).
    const mode = this.agentModesBySession().get(sessionKey)?.[0] ?? 'default';

    return rows.map<Interaction>((row) => ({
      timestampMs: row.start_time_ms,
      sessionId: sessionKey,
      traceId: row.trace_id,
      spanId: row.span_id,
      operation: row.operation_name ?? 'chat',
      agentName: row.agent_name !== null && row.agent_name.length > 0 ? row.agent_name : DEFAULT_AGENT,
      agentMode: mode,
      model: resolveModel(row.response_model, row.request_model),
      toolName: row.tool_name !== null && row.tool_name.length > 0 ? row.tool_name : undefined,
      durationMs: row.end_time_ms - row.start_time_ms,
      success: statusToSuccess(row.status_code),
      inputTokens: row.input_tokens ?? 0,
      outputTokens: row.output_tokens ?? 0,
      cachedTokens: row.cached_tokens ?? 0,
      repository,
    }));
  }

  /**
   * Safe per-span rows for the Phase 5 cloud aggregate engine, optionally bounded
   * to `[sinceMs, untilMs)` on `start_time_ms` (sinceMs inclusive, untilMs
   * exclusive). Returns ONLY non-sensitive aggregation metadata — never any
   * raw-content attribute key.
   *
   * Privacy-critical chokepoints applied HERE so no free text reaches the
   * aggregator/payload:
   * - `repository`: SANITIZED per session via the resolver (canonical URL or
   *   `unknown`); the raw `copilot_chat.repo.remote_url` never surfaces.
   * - `agentMode`: the session's first distinct mapped mode (default `default`),
   *   with any custom mode collapsed to `custom` by {@link mapAgentMode}.
   * - `toolName`: present only for `execute_tool` spans, passed through
   *   {@link mapToolName} so any non-builtin (third-party / MCP) tool becomes
   *   `custom`.
   *
   * Ordered by `start_time_ms` for stable downstream binning.
   */
  getAggregationRows(sinceMs?: number, untilMs?: number): AggregationRow[] {
    const clauses: string[] = [];
    const params: number[] = [];
    if (sinceMs !== undefined) {
      clauses.push('start_time_ms >= ?');
      params.push(sinceMs);
    }
    if (untilMs !== undefined) {
      clauses.push('start_time_ms < ?');
      params.push(untilMs);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    // reasoning_tokens is optional/provider-specific and not a required column;
    // select it only when present so a v1 DB that omits it still aggregates.
    const reasoningCol = this.spansColumns().has('reasoning_tokens')
      ? 'reasoning_tokens'
      : 'NULL AS reasoning_tokens';

    const rows = this.allRows<{
      session_key: string | null;
      start_time_ms: number;
      end_time_ms: number;
      status_code: number | null;
      operation_name: string | null;
      response_model: string | null;
      request_model: string | null;
      tool_name: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
      reasoning_tokens: number | null;
    }>(
      `SELECT COALESCE(conversation_id, chat_session_id) AS session_key,
                start_time_ms, end_time_ms, status_code, operation_name,
                response_model, request_model, tool_name,
                input_tokens, output_tokens, cached_tokens, ${reasoningCol}
         FROM spans
         ${where}
         ORDER BY start_time_ms ASC, span_id ASC`,
      params,
    );

    const resolver = this.resolver();
    const modesBySession = this.agentModesBySession();

    const result: AggregationRow[] = [];
    for (const row of rows) {
      const sessionKey = row.session_key ?? '';
      const operation = row.operation_name ?? 'chat';
      const agentMode = modesBySession.get(sessionKey)?.[0] ?? 'default';
      const toolName =
        operation === 'execute_tool' ? mapToolName(row.tool_name) : undefined;

      result.push({
        startTimeMs: row.start_time_ms,
        sessionKey,
        repository: resolver.resolve(sessionKey),
        // Cloud path only: collapse display-name models (e.g. "GPT-4o (Preview)")
        // to a contract-safe id so the server's model regex never 400s the batch.
        // Local views keep the friendly name via the bare resolveModel.
        model: sanitizeModelId(resolveModel(row.response_model, row.request_model)),
        agentMode,
        operation,
        toolName,
        durationMs: row.end_time_ms - row.start_time_ms,
        statusCode: row.status_code ?? 0,
        inputTokens: row.input_tokens ?? 0,
        outputTokens: row.output_tokens ?? 0,
        cachedTokens: row.cached_tokens ?? 0,
        reasoningTokens: row.reasoning_tokens ?? 0,
      });
    }
    return result;
  }

  /**
   * Full drill-down for a single session for the LOCAL detail panel: a
   * {@link SessionSummary} header plus a chronological timeline.
   *
   * PRIVACY: this is the ONLY method that reads raw content. For the LLM spans
   * (`chat` and `invoke_agent`) it additionally reads the
   * `copilot_chat.user_request` and `gen_ai.output.messages` attributes into the
   * per-turn {@link SessionTurn.userRequest} / {@link SessionTurn.finalResponse}.
   * The caller renders them locally (HTML-escaped) and never logs or uploads
   * them. All other metadata methods on this class stay strictly content-free.
   *
   * Returns `undefined` when the session key has no spans.
   */
  getSessionDetail(
    sessionKey: string,
    codeExts: readonly string[] = [],
    docExts: readonly string[] = [],
  ): SessionDetail | undefined {
    const resolver = this.resolver();
    const repository = resolver.resolve(sessionKey);

    // reasoning_tokens is optional/provider-specific and not a required column;
    // select it only when present so a v1 DB that omits it still renders (same
    // pattern as getAggregationRows).
    const reasoningCol = this.spansColumns().has('reasoning_tokens')
      ? 'reasoning_tokens'
      : 'NULL AS reasoning_tokens';

    const rows = this.allRows<{
      span_id: string;
      start_time_ms: number;
      end_time_ms: number;
      status_code: number;
      operation_name: string | null;
      agent_name: string | null;
      request_model: string | null;
      response_model: string | null;
      tool_name: string | null;
      conversation_id: string | null;
      chat_session_id: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
      reasoning_tokens: number | null;
    }>(
      `SELECT span_id, start_time_ms, end_time_ms, status_code,
                operation_name, agent_name, request_model, response_model, tool_name,
                conversation_id, chat_session_id,
                input_tokens, output_tokens, cached_tokens, ${reasoningCol}
         FROM spans
         WHERE COALESCE(conversation_id, chat_session_id) = ?
         ORDER BY start_time_ms ASC, span_id ASC`,
      [sessionKey],
    );

    if (rows.length === 0) {
      return undefined;
    }

    // LOCAL-ONLY raw user requests + assistant responses, keyed by span id,
    // scoped to the LLM spans (chat + invoke_agent). Used only to build the
    // per-turn request/response below; never logged or uploaded.
    const userRequests = this.userRequestsBySpan(sessionKey);
    const responses = this.responsesBySpan(sessionKey);
    const mode = this.agentModesBySession().get(sessionKey)?.[0] ?? 'default';

    // Whether to compute LoC/LoD at all — skipped (counts stay 0) when no extension
    // lists are configured. The per-turn counts are NOT filled in this loop; they
    // are bucketed in AFTER the turns are built, from the WHOLE TREE's file-writes
    // (incl. spawned sub-agents) — see the timestamp bucketing below.
    const wantsLineCounts = codeExts.length > 0 || docExts.length > 0;

    let startedAtMs = rows[0].start_time_ms;
    let endedAtMs = rows[0].end_time_ms;
    let llmCalls = 0;
    let toolCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

    // The per-model and per-agent breakdowns are NOT built here: they aggregate
    // the whole agent tree's `chat` spans (incl. spawned sub-agents) via
    // {@link treeUsageRollups}, so they reconcile with the tree-stats card. This
    // loop builds only the main-thread {@link SessionSummary} totals, timeline,
    // and turns. See the `invoke-agent-token-double-count` investigation for why
    // the header summary stays main-thread (chat + main-thread invoke_agent).
    const timeline: SessionTimelineEntry[] = rows.map((row) => {
      const operation = row.operation_name ?? 'chat';
      const model = resolveModel(row.response_model, row.request_model);
      const rowInput = row.input_tokens ?? 0;
      const rowOutput = row.output_tokens ?? 0;
      const rowCached = row.cached_tokens ?? 0;

      // A spawned sub-agent invocation carries the parent conversation_id but a
      // distinct chat_session_id (the spawning tool-call id); its tokens belong
      // to the sub-agent's own session, so it must not contribute here.
      const isSpawnedSubAgent =
        operation === 'invoke_agent' &&
        row.conversation_id !== null &&
        row.chat_session_id !== null &&
        row.conversation_id !== row.chat_session_id;
      // Count tokens once per real main-thread LLM call.
      const countsTokens =
        operation === 'chat' || (operation === 'invoke_agent' && !isSpawnedSubAgent);

      // Count an LLM call for every main-thread LLM span — `chat` (ask mode) AND
      // main-thread `invoke_agent` (agent mode emits its turns here, not as
      // `chat`). Mirrors `countsTokens` so the header LLM-call count agrees with
      // the per-turn rollups; spawned sub-agents are excluded for the same reason
      // their tokens are (they belong to their own session).
      if (countsTokens) {
        llmCalls += 1;
      } else if (operation === 'execute_tool') {
        toolCalls += 1;
      }

      // Header (main-thread) token totals. The per-model/per-agent breakdowns are
      // built separately over the whole tree in treeUsageRollups().
      if (countsTokens) {
        // TIN excludes the row's cache reads (counted in `cachedTokens`) so the
        // two buckets stay disjoint; per-row subtraction sums to gross − cached.
        inputTokens += freshInput(rowInput, rowCached);
        outputTokens += rowOutput;
        cachedTokens += rowCached;
      }
      if (row.start_time_ms < startedAtMs) {
        startedAtMs = row.start_time_ms;
      }
      if (row.end_time_ms > endedAtMs) {
        endedAtMs = row.end_time_ms;
      }

      // user_request is read for any LLM span that carries it (privacy-scoped,
      // local display); on a nested event this surfaces a sub-agent's own prompt.
      const userRequest = userRequests.get(row.span_id);

      return {
        timestampMs: row.start_time_ms,
        operation,
        agentMode: mode,
        model,
        toolName:
          row.tool_name !== null && row.tool_name.length > 0 ? row.tool_name : undefined,
        durationMs: row.end_time_ms - row.start_time_ms,
        success: statusToSuccess(row.status_code),
        userRequest,
      };
    });

    // Group the chronological spans into per-user-request turns. A turn is
    // anchored by a MAIN-THREAD LLM span carrying a user_request: a `chat` span
    // (ask mode) or an `invoke_agent` span that is NOT a spawned sub-agent (agent
    // mode). Every other span — tools, hooks, and spawned sub-agent invocations —
    // becomes an `event` of the open turn. Spans preceding the first anchor (or
    // tool-only sessions with no anchor at all) collect into a leading synthetic
    // turn so `turns` always partitions every span. `rows` and `timeline` are
    // index-aligned (timeline is `rows.map(...)`), so we zip them here.
    const turns: SessionTurn[] = [];
    let currentTurn: SessionTurn | undefined;
    rows.forEach((row, i) => {
      const operation = row.operation_name ?? 'chat';
      const isSpawnedSubAgent =
        operation === 'invoke_agent' &&
        row.conversation_id !== null &&
        row.chat_session_id !== null &&
        row.conversation_id !== row.chat_session_id;
      const isAnchor =
        userRequests.has(row.span_id) &&
        (operation === 'chat' || (operation === 'invoke_agent' && !isSpawnedSubAgent));

      if (isAnchor) {
        const responseRaw = responses.get(row.span_id);
        currentTurn = {
          timestampMs: row.start_time_ms,
          agentMode: mode,
          model: resolveModel(row.response_model, row.request_model),
          durationMs: row.end_time_ms - row.start_time_ms,
          success: statusToSuccess(row.status_code),
          userRequest: userRequests.get(row.span_id),
          finalResponse:
            responseRaw !== undefined ? extractResponseText(responseRaw) : undefined,
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          linesOfCode: 0,
          linesOfDoc: 0,
          linesOfCodeRemoved: 0,
          linesOfDocRemoved: 0,
          events: [],
        };
        turns.push(currentTurn);
      } else {
        if (currentTurn === undefined) {
          // Leading spans before any user request: a synthetic, request-less turn.
          currentTurn = {
            timestampMs: row.start_time_ms,
            agentMode: mode,
            model: resolveModel(row.response_model, row.request_model),
            durationMs: 0,
            success: true,
            llmCalls: 0,
            inputTokens: 0,
            outputTokens: 0,
            cachedTokens: 0,
            reasoningTokens: 0,
            linesOfCode: 0,
            linesOfDoc: 0,
            linesOfCodeRemoved: 0,
            linesOfDocRemoved: 0,
            events: [],
          };
          turns.push(currentTurn);
        }
        currentTurn.events.push(timeline[i]);
      }

      // Attribute MAIN-THREAD LLM tokens (the anchor itself, plus any main-thread
      // chat/invoke_agent event) to the open turn — mirroring the session-total
      // rule above. Sub-agent spans are excluded, so summing turns reproduces the
      // header totals.
      if (operation === 'chat' || (operation === 'invoke_agent' && !isSpawnedSubAgent)) {
        currentTurn.llmCalls += 1;
        // TIN excludes cache reads (see the header-totals rule above) so summing
        // turns still reproduces the header's fresh-input total.
        currentTurn.inputTokens += freshInput(row.input_tokens ?? 0, row.cached_tokens ?? 0);
        currentTurn.outputTokens += row.output_tokens ?? 0;
        currentTurn.cachedTokens += row.cached_tokens ?? 0;
        currentTurn.reasoningTokens += row.reasoning_tokens ?? 0;
      }
    });

    // Per-turn LoC/LoD over the WHOLE agent tree (incl. spawned sub-agents), so the
    // trend bars reconcile with the "Agent run totals" card. In agent mode the file
    // edits run inside sub-agents whose `execute_tool` spans are NOT in `rows`
    // (scoped to the main session), which is why a main-thread-only count left every
    // bar at 0 even though the tree total was non-zero. Each tree-wide file-write is
    // attributed to the turn whose window contains its start time: turns are in
    // ascending start order, so the last turn whose start <= the write's start owns
    // it (the main thread blocks on a spawned sub-agent, so its writes fall inside
    // the spawning turn's window). Summing the turns therefore reproduces the tree
    // line totals.
    if (wantsLineCounts && turns.length > 0) {
      for (const w of this.treeWrittenLinesBySpan(sessionKey, codeExts, docExts)) {
        const idx = timeBucket(turns, w.startMs, (turn) => turn.timestampMs);
        const turn = turns[idx];
        turn.linesOfCode += w.delta.added.code;
        turn.linesOfDoc += w.delta.added.doc;
        turn.linesOfCodeRemoved += w.delta.removed.code;
        turn.linesOfDocRemoved += w.delta.removed.doc;
      }
    }

    // Per-model and per-agent breakdowns over the WHOLE agent tree's chat spans
    // (incl. spawned sub-agents), so each agent/model shows its real tokens AND
    // AIU and the tables reconcile with the tree-stats card below — unlike the
    // main-thread `summary`. See treeUsageRollups().
    const { modelUsage, agentUsage } = this.treeUsageRollups(sessionKey, codeExts, docExts);

    const summary: SessionSummary = {
      sessionId: sessionKey,
      repository,
      startedAtMs,
      endedAtMs,
      durationMs: endedAtMs - startedAtMs,
      interactionCount: rows.length,
      llmCalls,
      toolCalls,
      inputTokens,
      outputTokens,
      cachedTokens,
      model: this.modelBySession().get(sessionKey) ?? 'unknown',
      agentModes: [...(this.agentModesBySession().get(sessionKey) ?? ['default'])],
    };

    // Whole-agent-tree rollup (incl. spawned sub-agents) for the GitHub-matching
    // summary card. rows.length > 0 here, so the root is part of a non-empty tree
    // and getSessionTreeStats never returns undefined; the ?? is belt-and-braces.
    const treeStats = this.getSessionTreeStats(sessionKey, codeExts, docExts) ?? EMPTY_TREE_STATS;

    // Whole-tree model-turn series for the token trend, taken over the same tree
    // `chat` spans as treeStats so the trend reconciles with the card it sits in.
    const treeModelTurns = this.treeModelTurnPoints(sessionKey, codeExts, docExts);

    return { summary, treeStats, turns, modelUsage, agentUsage, treeModelTurns };
  }

  /**
   * The WHOLE agent tree's model turns as an ordered point series for the detail
   * panel's token trend ({@link SessionModelTurnPoint}). Taken over the same tree
   * `chat` spans as {@link getSessionTreeStats} — the connected
   * `conversation_id`/`chat_session_id` component rooted at `sessionKey` — so the
   * count equals the card's Model Turns and the per-field sums equal its token /
   * line totals. This deliberately differs from the main-thread {@link SessionTurn}
   * grouping, whose single-id `rows` query misses the chat turns agent mode records
   * under child conversation ids.
   *
   * LoC/LoD (when extension lists are supplied) come from the same whole-tree
   * file-writes as the card; each write is attributed to the model turn that
   * requested it — the last `chat` span whose start <= the write's start —
   * falling back to the first when a write precedes every model turn. Summing the
   * points' line counts therefore reproduces the card's tree totals.
   */
  private treeModelTurnPoints(
    sessionKey: string,
    codeExts: readonly string[],
    docExts: readonly string[],
  ): SessionModelTurnPoint[] {
    const ids = this.sessionTreeIds(sessionKey);
    if (ids.length === 0) {
      return [];
    }
    const inList = ids.map(() => '?').join(', ');
    const reasoningCol = this.spansColumns().has('reasoning_tokens')
      ? 'reasoning_tokens'
      : 'NULL AS reasoning_tokens';

    const rows = this.allRows<{
      start_time_ms: number;
      request_model: string | null;
      response_model: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
      reasoning_tokens: number | null;
    }>(
      `SELECT start_time_ms, request_model, response_model,
              input_tokens, output_tokens, cached_tokens, ${reasoningCol}
         FROM spans
         WHERE operation_name = 'chat'
           AND (conversation_id IN (${inList}) OR chat_session_id IN (${inList}))
         ORDER BY start_time_ms ASC, span_id ASC`,
      [...ids, ...ids],
    );

    const points: SessionModelTurnPoint[] = rows.map((row) => ({
      timestampMs: row.start_time_ms,
      model: resolveModel(row.response_model, row.request_model),
      // TIN = fresh (non-cache-read) input so the trend's per-field sums still
      // reconcile with the tree-stats card (which is also fresh).
      inputTokens: freshInput(row.input_tokens ?? 0, row.cached_tokens ?? 0),
      outputTokens: row.output_tokens ?? 0,
      cachedTokens: row.cached_tokens ?? 0,
      reasoningTokens: row.reasoning_tokens ?? 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    }));

    const wantsLineCounts = codeExts.length > 0 || docExts.length > 0;
    if (wantsLineCounts && points.length > 0) {
      for (const w of this.treeWrittenLinesBySpan(sessionKey, codeExts, docExts)) {
        const idx = timeBucket(points, w.startMs, (point) => point.timestampMs);
        points[idx].linesOfCode += w.delta.added.code;
        points[idx].linesOfDoc += w.delta.added.doc;
        points[idx].linesOfCodeRemoved += w.delta.removed.code;
        points[idx].linesOfDocRemoved += w.delta.removed.doc;
      }
    }
    return points;
  }

  /**
   * Whole-agent-tree totals for the LOCAL detail panel's summary card, matching
   * GitHub's per-session Agent Debug Logs. Unlike {@link getSessionDetail}'s
   * main-thread {@link SessionSummary} (which excludes spawned sub-agents to avoid
   * the cross-session double-count), this aggregates the ENTIRE agent tree rooted
   * at `sessionKey` — the main conversation plus every sub-agent it spawned.
   *
   * The tree is the connected component over `conversation_id` / `chat_session_id`
   * edges (see {@link sessionTreeIds}). All counts and token sums are taken over
   * that component's `chat` spans: each model turn is counted once, and because an
   * `invoke_agent` span is only a per-agent rollup of its own `chat` turns,
   * summing `chat` avoids the double-count that summing both would cause.
   *
   * Returns `undefined` when the tree has no spans (unknown session key).
   *
   * When `codeExts`/`docExts` are supplied, the whole-tree Lines-of-Code /
   * Lines-of-Documentation counts (added and removed) are computed LOCALLY from
   * the file-writing tool calls' raw `gen_ai.tool.call.arguments`; only the
   * integer counts are retained. With no lists (the default) those counts are 0.
   */
  getSessionTreeStats(
    sessionKey: string,
    codeExts: readonly string[] = [],
    docExts: readonly string[] = [],
  ): SessionTreeStats | undefined {
    const ids = this.sessionTreeIds(sessionKey);
    if (ids.length === 0) {
      return undefined;
    }
    // Dynamic placeholder list — ids are bound as parameters, never interpolated
    // (same safe-assembly discipline as the optional reasoningCol elsewhere).
    const inList = ids.map(() => '?').join(', ');

    const agg = this.getRow<{
      span_count: number;
      model_turns: number;
      tool_calls: number;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
      error_count: number;
    }>(
      `SELECT
           COUNT(*) AS span_count,
           SUM(CASE WHEN operation_name = 'chat' THEN 1 ELSE 0 END) AS model_turns,
           SUM(CASE WHEN operation_name = 'execute_tool' THEN 1 ELSE 0 END) AS tool_calls,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(cached_tokens, 0) ELSE 0 END) AS cached_tokens,
           SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
         FROM spans
         WHERE conversation_id IN (${inList}) OR chat_session_id IN (${inList})`,
      [...ids, ...ids],
    );

    // No spans matched — the root key is unknown (no spans anchor to it). An
    // aggregate query always returns one row, so distinguish "empty" by the count
    // rather than a missing row.
    if (agg === undefined || agg.span_count === 0) {
      return undefined;
    }

    // AIU (GitHub's billed premium-request units) is recorded on `chat` spans via
    // a span attribute; sum it over the same tree. Integer nano keeps sums exact.
    const aiuRow = this.getRow<{ aiu_nano: number | null }>(
      `SELECT SUM(CAST(a.value AS INTEGER)) AS aiu_nano
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
         WHERE a.key = 'copilot_chat.copilot_usage_nano_aiu'
           AND s.operation_name = 'chat'
           AND (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))`,
      [...ids, ...ids],
    );

    // LOCAL-ONLY Lines-of-Code / Lines-of-Documentation over the tree's
    // file-writing tool calls. Skipped (counts stay 0) when no extension lists
    // are configured. The raw arguments are read here and discarded; only the
    // parsed integer line counts leave this method.
    const writeLines = { added: { code: 0, doc: 0 }, removed: { code: 0, doc: 0 } };
    if (codeExts.length > 0 || docExts.length > 0) {
      for (const { delta } of this.treeWrittenLinesBySpan(sessionKey, codeExts, docExts)) {
        writeLines.added.code += delta.added.code;
        writeLines.added.doc += delta.added.doc;
        writeLines.removed.code += delta.removed.code;
        writeLines.removed.doc += delta.removed.doc;
      }
    }

    const cachedTokens = agg.cached_tokens ?? 0;
    // TIN = fresh (non-cache-read) input; cache reads are the disjoint TCI bucket.
    const inputTokens = freshInput(agg.input_tokens ?? 0, cachedTokens);
    const outputTokens = agg.output_tokens ?? 0;
    return {
      modelTurns: agg.model_turns ?? 0,
      toolCalls: agg.tool_calls ?? 0,
      inputTokens,
      outputTokens,
      cachedTokens,
      // True total over disjoint buckets (= gross input + output; value unchanged).
      totalTokens: inputTokens + cachedTokens + outputTokens,
      errorCount: agg.error_count ?? 0,
      aiuNano: aiuRow?.aiu_nano ?? 0,
      linesOfCode: writeLines.added.code,
      linesOfDoc: writeLines.added.doc,
      linesOfCodeRemoved: writeLines.removed.code,
      linesOfDocRemoved: writeLines.removed.doc,
    };
  }

  /**
   * Per-model and per-(agent, model) usage breakdowns for the detail view, taken
   * over the WHOLE agent tree's `chat` spans (the main conversation plus every
   * spawned sub-agent — see {@link sessionTreeIds}). This mirrors the source the
   * {@link getSessionTreeStats} card uses, so the breakdown tables reconcile with
   * it: each agent and model shows its real tokens AND AIU. (The single-session
   * `summary` stays main-thread by design; the breakdowns intentionally do not.)
   *
   * AIU lives only on `chat` spans, and a sub-agent's `chat` spans sit under their
   * OWN conversation id — outside the single-session scope — which is why the old
   * per-session breakdown read 0 AIU for sub-agents. Aggregating the tree's `chat`
   * spans fixes that without double-counting (an `invoke_agent` rollup is excluded;
   * each turn is one `chat` span). A turn is classified `subagent` by its
   * `copilot_chat.debug_log_label` (`runSubagent-*`) / `agent_name`
   * (`tool/runSubagent*`) — a root-INDEPENDENT signal, so opening any node of the
   * tree (the agent root OR a constituent conversation, which share one tree)
   * labels turns consistently. The friendly agent label comes from the same
   * `debug_log_label`, which is reliable where `agent_name` is not.
   */
  private treeUsageRollups(
    rootKey: string,
    codeExts: readonly string[] = [],
    docExts: readonly string[] = [],
  ): {
    modelUsage: SessionModelUsage[];
    agentUsage: SessionAgentUsage[];
  } {
    const ids = this.sessionTreeIds(rootKey);
    const inList = ids.map(() => '?').join(', ');
    // reasoning_tokens is optional/provider-specific; only sum it when present.
    const reasoningSel = this.spansColumns().has('reasoning_tokens')
      ? 'SUM(COALESCE(s.reasoning_tokens, 0))'
      : '0';

    const rows = this.allRows<{
      agent_name: string | null;
      response_model: string | null;
      request_model: string | null;
      chat_session_id: string | null;
      debug_label: string | null;
      llm_calls: number;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
      reasoning_tokens: number | null;
      aiu_nano: number | null;
      started_at_ms: number | null;
      ended_at_ms: number | null;
    }>(
      // Each chat span carries at most one debug_log_label and one nano-AIU
      // attribute, so the two LEFT JOINs are 1:1 and do not multiply rows.
      `SELECT s.agent_name AS agent_name,
              s.response_model AS response_model,
              s.request_model AS request_model,
              s.chat_session_id AS chat_session_id,
              lbl.value AS debug_label,
              COUNT(*) AS llm_calls,
              SUM(COALESCE(s.input_tokens, 0)) AS input_tokens,
              SUM(COALESCE(s.output_tokens, 0)) AS output_tokens,
              SUM(COALESCE(s.cached_tokens, 0)) AS cached_tokens,
              ${reasoningSel} AS reasoning_tokens,
              SUM(CASE WHEN aiu.value IS NOT NULL THEN CAST(aiu.value AS INTEGER) ELSE 0 END) AS aiu_nano,
              MIN(CASE WHEN s.start_time_ms > 0 THEN s.start_time_ms END) AS started_at_ms,
              MAX(s.end_time_ms) AS ended_at_ms
         FROM spans s
         LEFT JOIN span_attributes lbl
           ON lbl.span_id = s.span_id AND lbl.key = 'copilot_chat.debug_log_label'
         LEFT JOIN span_attributes aiu
           ON aiu.span_id = s.span_id AND aiu.key = 'copilot_chat.copilot_usage_nano_aiu'
        WHERE s.operation_name = 'chat'
          AND (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))
        GROUP BY s.agent_name, s.response_model, s.request_model, s.chat_session_id, lbl.value`,
      [...ids, ...ids],
    );

    const usageByModel = new Map<string, SessionModelUsage>();
    const usageByAgent = new Map<string, SessionAgentUsage>();
    // Wall-clock bounds per agent key; folded across the SQL group rows (the same
    // key arrives once per chat_session_id / model form / debug label).
    const timeByAgent = new Map<string, { startMs: number; endMs: number }>();

    for (const row of rows) {
      const model = resolveModel(row.response_model, row.request_model);
      // Spawned sub-agent turns are tagged by Copilot with a `runSubagent-*`
      // debug-log label and a `tool/runSubagent*` agent_name; the main thread
      // carries neither. This is independent of which tree node `rootKey` is.
      const isSubagent =
        (row.debug_label !== null && row.debug_label.startsWith('runSubagent-')) ||
        (row.agent_name !== null && row.agent_name.startsWith('tool/runSubagent'));
      const kind: 'main' | 'subagent' = isSubagent ? 'subagent' : 'main';
      const agentName = friendlyAgentName(kind, row.agent_name, row.debug_label);
      const calls = row.llm_calls;
      const cached = row.cached_tokens ?? 0;
      // TIN = fresh (non-cache-read) input, disjoint from `cached`; matches the
      // tiles/header so the per-model/per-agent tables reconcile with the card.
      const input = freshInput(row.input_tokens ?? 0, cached);
      const output = row.output_tokens ?? 0;
      const reasoning = row.reasoning_tokens ?? 0;
      const aiu = row.aiu_nano ?? 0;

      // Per-(agent, model, kind): multiple main conversations (all carrying the
      // root chat_session_id) and repeat invocations of the same-named sub-agent
      // fold together here.
      const agentKey = agentUsageKey({ agentName, model, kind });
      let agent = usageByAgent.get(agentKey);
      if (agent === undefined) {
        agent = {
          agentName,
          model,
          kind,
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          aiuNano: 0,
          linesOfCode: 0,
          linesOfDoc: 0,
          linesOfCodeRemoved: 0,
          linesOfDocRemoved: 0,
        };
        usageByAgent.set(agentKey, agent);
      }
      agent.llmCalls += calls;
      agent.inputTokens += input;
      agent.outputTokens += output;
      agent.cachedTokens += cached;
      agent.reasoningTokens += reasoning;
      agent.aiuNano += aiu;

      if (
        row.started_at_ms !== null &&
        row.ended_at_ms !== null &&
        row.ended_at_ms >= row.started_at_ms
      ) {
        const t = timeByAgent.get(agentKey);
        if (t === undefined) {
          timeByAgent.set(agentKey, { startMs: row.started_at_ms, endMs: row.ended_at_ms });
        } else {
          t.startMs = Math.min(t.startMs, row.started_at_ms);
          t.endMs = Math.max(t.endMs, row.ended_at_ms);
        }
      }

      let usage = usageByModel.get(model);
      if (usage === undefined) {
        usage = {
          model,
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          reasoningTokens: 0,
          aiuNano: 0,
        };
        usageByModel.set(model, usage);
      }
      usage.llmCalls += calls;
      usage.inputTokens += input;
      usage.outputTokens += output;
      usage.cachedTokens += cached;
      usage.reasoningTokens += reasoning;
      usage.aiuNano += aiu;
    }

    for (const [key, t] of timeByAgent) {
      const agent = usageByAgent.get(key);
      if (agent !== undefined) {
        agent.runDurationMs = Math.max(0, t.endMs - t.startMs);
      }
    }

    // Per-(agent, model, kind) LoC/LoD over the WHOLE tree's file-writes, attributed
    // the same way as the trend points / the per-turn counts: each write is owned by
    // the model turn (`chat` span) that requested it — the last chat span whose start
    // <= the write's start (fallback to the first when a write precedes every turn) —
    // and that turn's (agent, model, kind) accrues the lines. Because every chat span
    // already produced a token row above, its key exists in `usageByAgent`; summing
    // the rows therefore reproduces the tree's line totals.
    const wantsLineCounts = codeExts.length > 0 || docExts.length > 0;
    if (wantsLineCounts) {
      const turns = this.treeChatSpanKeys(rootKey);
      if (turns.length > 0) {
        for (const w of this.treeWrittenLinesBySpan(rootKey, codeExts, docExts)) {
          const idx = timeBucket(turns, w.startMs, (turn) => turn.startMs);
          const agent = usageByAgent.get(turns[idx].key);
          if (agent !== undefined) {
            agent.linesOfCode += w.delta.added.code;
            agent.linesOfDoc += w.delta.added.doc;
            agent.linesOfCodeRemoved += w.delta.removed.code;
            agent.linesOfDocRemoved += w.delta.removed.doc;
          }
        }
      }
    }

    // Sort by total tokens (input + output) desc, then model id asc for a stable
    // order when token counts tie.
    const modelUsage = [...usageByModel.values()].sort((a, b) => {
      const byTokens = b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
      return byTokens !== 0 ? byTokens : a.model.localeCompare(b.model);
    });

    // Main-thread rows first, then sub-agents; within each group, heaviest
    // (input + output) first, then agent/model for a stable tie-break.
    const agentUsage = [...usageByAgent.values()].sort((a, b) => {
      if (a.kind !== b.kind) {
        return a.kind === 'main' ? -1 : 1;
      }
      const byTokens = b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
      if (byTokens !== 0) {
        return byTokens;
      }
      const byAgent = a.agentName.localeCompare(b.agentName);
      return byAgent !== 0 ? byAgent : a.model.localeCompare(b.model);
    });

    return { modelUsage, agentUsage };
  }

  /**
   * The WHOLE agent tree's `chat` spans as an ordered list of (start time →
   * {@link agentUsageKey}) pairs, for attributing each file-write to the (agent,
   * model, kind) of the model turn that requested it. Classifies every span exactly
   * as {@link treeUsageRollups} does (same `runSubagent` sub-agent detection,
   * {@link friendlyAgentName}, and {@link resolveModel}), so each key here matches a
   * row produced there. Ordered by start time so the caller can pick the last turn
   * whose start precedes a write — the same attribution rule the trend points use.
   */
  private treeChatSpanKeys(rootKey: string): Array<{ startMs: number; key: string }> {
    const ids = this.sessionTreeIds(rootKey);
    if (ids.length === 0) {
      return [];
    }
    const inList = ids.map(() => '?').join(', ');
    const rows = this.allRows<{
      start_time_ms: number;
      agent_name: string | null;
      response_model: string | null;
      request_model: string | null;
      debug_label: string | null;
    }>(
      `SELECT s.start_time_ms AS start_time_ms,
              s.agent_name AS agent_name,
              s.response_model AS response_model,
              s.request_model AS request_model,
              lbl.value AS debug_label
         FROM spans s
         LEFT JOIN span_attributes lbl
           ON lbl.span_id = s.span_id AND lbl.key = 'copilot_chat.debug_log_label'
        WHERE s.operation_name = 'chat'
          AND (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))
        ORDER BY s.start_time_ms ASC, s.span_id ASC`,
      [...ids, ...ids],
    );

    return rows.map((row) => {
      const model = resolveModel(row.response_model, row.request_model);
      const isSubagent =
        (row.debug_label !== null && row.debug_label.startsWith('runSubagent-')) ||
        (row.agent_name !== null && row.agent_name.startsWith('tool/runSubagent'));
      const kind: 'main' | 'subagent' = isSubagent ? 'subagent' : 'main';
      const agentName = friendlyAgentName(kind, row.agent_name, row.debug_label);
      return { startMs: row.start_time_ms, key: agentUsageKey({ agentName, model, kind }) };
    });
  }

  /**
   * The set of session ids forming the agent tree rooted at `rootKey`: the
   * connected component over `conversation_id` / `chat_session_id` edges. A
   * Copilot agent run links its main conversation to each spawned sub-agent by
   * sharing ids — the spawned `invoke_agent` span carries the parent
   * `conversation_id` and the spawn tool-call id as `chat_session_id`, and the
   * sub-agent's own spans carry that sub-agent's `conversation_id` with the parent
   * `chat_session_id` — so walking both edges transitively collects the whole run.
   *
   * Implemented as a bounded breadth-first walk (each round expands the frontier
   * by one hop); the {@link MAX_TREE_HOPS} cap is a defensive backstop against a
   * pathological cycle and is far above any real agent nesting depth. In real data
   * the component is exactly one agent run; independent sessions never share ids.
   */
  private sessionTreeIds(rootKey: string): string[] {
    if (this.treeCache?.root === rootKey) {
      return this.treeCache.ids;
    }
    const seen = new Set<string>([rootKey]);
    let frontier: string[] = [rootKey];
    for (let hop = 0; hop < MAX_TREE_HOPS && frontier.length > 0; hop++) {
      const next: string[] = [];
      for (const id of frontier) {
        const rows = this.allRows<{
          conversation_id: string | null;
          chat_session_id: string | null;
        }>(
          `SELECT DISTINCT conversation_id, chat_session_id
             FROM spans
             WHERE conversation_id = ? OR chat_session_id = ?`,
          [id, id],
        );
        for (const row of rows) {
          for (const value of [row.conversation_id, row.chat_session_id]) {
            if (value !== null && value.length > 0 && !seen.has(value)) {
              seen.add(value);
              next.push(value);
            }
          }
        }
      }
      frontier = next;
    }
    // Always includes rootKey. When rootKey is unknown (no spans), the walk adds
    // nothing and this is just [rootKey]; the caller detects emptiness via the
    // span COUNT, not the id-set size.
    const ids = [...seen];
    this.treeCache = { root: rootKey, ids };
    return ids;
  }

  /**
   * LOCAL-ONLY: map span id → raw value of `attributeKey` for the spans of a
   * single session. The local equivalent of a cloud KQL step query that reads log
   * CONTENT, used solely by the local workflow-deviation path
   * ({@link ../deviation/models.ContentPredicate}) for on-machine evaluation.
   *
   * PRIVACY: the returned text is never logged, never uploaded, and this method is
   * NEVER called from {@link getAggregationRows} or any method in `src/aggregate/`
   * (the aggregate/sync path is strictly content-free). The caller restricts
   * `attributeKey` to the content-predicate allow-list
   * ({@link ../deviation/models.CONTENT_PREDICATE_ATTRIBUTES}); the key is bound as
   * a SQL parameter, never interpolated. Unlike {@link userRequestsBySpan} this is
   * not scoped to chat spans, since content predicates may target tool/hook spans.
   */
  getAttributesBySpan(sessionKey: string, attributeKey: string): Map<string, string> {
    const rows = this.allRows<{ span_id: string; value: string | null }>(
      `SELECT a.span_id AS span_id, a.value AS value
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
         WHERE a.key = ?
           AND COALESCE(s.conversation_id, s.chat_session_id) = ?`,
      [attributeKey, sessionKey],
    );

    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.value !== null) {
        map.set(row.span_id, row.value);
      }
    }
    return map;
  }

  /**
   * LOCAL-ONLY: map span id → raw `copilot_chat.user_request` value for the LLM
   * spans (`chat` and `invoke_agent`) of a single session. Used solely by
   * {@link getSessionDetail} for local webview display; never logged or uploaded.
   *
   * Both operations are included because agent-mode sessions carry the request on
   * `invoke_agent` spans (often with ZERO `chat` spans); a chat-only filter would
   * silently drop every agent-mode prompt. The caller separates main-thread
   * anchors from spawned sub-agents via the conversation_id / chat_session_id
   * relationship, so no extra scoping is needed here.
   */
  private userRequestsBySpan(sessionKey: string): Map<string, string> {
    return this.contentBySpan(sessionKey, 'copilot_chat.user_request');
  }

  /**
   * LOCAL-ONLY: map span id → raw `gen_ai.output.messages` value for the LLM
   * spans (`chat` and `invoke_agent`) of a single session — the assistant's
   * response messages. Used solely by {@link getSessionDetail} to surface each
   * turn's final response (via {@link ./responseText.extractResponseText}); never
   * logged or uploaded. Same privacy class and scoping as
   * {@link userRequestsBySpan}.
   */
  private responsesBySpan(sessionKey: string): Map<string, string> {
    return this.contentBySpan(sessionKey, 'gen_ai.output.messages');
  }

  /**
   * LOCAL-ONLY shared helper for {@link userRequestsBySpan} /
   * {@link responsesBySpan}: map span id → non-empty raw `attributeKey` value for
   * the LLM spans (`chat` and `invoke_agent`) of a single session. `attributeKey`
   * is bound as a SQL parameter, never interpolated.
   */
  private contentBySpan(sessionKey: string, attributeKey: string): Map<string, string> {
    const rows = this.allRows<{ span_id: string; value: string | null }>(
      `SELECT a.span_id AS span_id, a.value AS value
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
         WHERE a.key = ?
           AND s.operation_name IN ('chat', 'invoke_agent')
           AND COALESCE(s.conversation_id, s.chat_session_id) = ?`,
      [attributeKey, sessionKey],
    );

    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.value !== null && row.value.length > 0) {
        map.set(row.span_id, row.value);
      }
    }
    return map;
  }

  /**
   * LOCAL-ONLY per-span file-write line counts over the WHOLE agent tree rooted at
   * `rootKey` (the root session plus every spawned sub-agent — see
   * {@link sessionTreeIds}), each tagged with the span's start time so the caller can
   * bucket it into the main-thread turn that was active. Mirrors the span selection
   * {@link getSessionTreeStats} uses for its LoC/LoD total, so summing these
   * reproduces that total. The raw `gen_ai.tool.call.arguments` (file path +
   * content/diff) are parsed into integer counts here and discarded; the raw value
   * is never logged or uploaded.
   */
  private treeWrittenLinesBySpan(
    rootKey: string,
    codeExts: readonly string[],
    docExts: readonly string[],
  ): Array<{ startMs: number; delta: WriteLineDelta }> {
    const extensions = JSON.stringify([codeExts, docExts]);
    if (this.writesCache?.root === rootKey && this.writesCache.extensions === extensions) {
      return this.writesCache.rows;
    }
    const ids = this.sessionTreeIds(rootKey);
    if (ids.length === 0) {
      return [];
    }
    // Dynamic placeholder list — ids are bound as parameters, never interpolated
    // (same safe-assembly discipline as getSessionTreeStats).
    const inList = ids.map(() => '?').join(', ');
    const rows = this.allRows<{
      start_time_ms: number;
      tool_name: string | null;
      value: string | null;
    }>(
      `SELECT s.start_time_ms AS start_time_ms, s.tool_name AS tool_name, a.value AS value
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
         WHERE a.key = ?
           AND s.operation_name = 'execute_tool'
           AND (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))`,
      [TOOL_ARGUMENTS_KEY, ...ids, ...ids],
    );

    const deltas = rows
      .filter(
        (r): r is { start_time_ms: number; tool_name: string | null; value: string } =>
          r.value !== null && r.value.length > 0,
      )
      .map((r) => ({
        startMs: r.start_time_ms,
        delta: countWrittenLines(r.tool_name ?? '', r.value, codeExts, docExts),
      }));
    this.writesCache = { root: rootKey, extensions, rows: deltas };
    return deltas;
  }


  /**
   * Map each session key (the `sessions` view's `COALESCE(conversation_id,
   * chat_session_id)`) to the UUID `chat_session_id` of its spans, when one
   * exists. The LOCAL title store is keyed by the chat-session UUID, but a
   * session key is frequently a `conversation_id` (a per-turn id) that differs
   * from it; this lets {@link ../telemetry/telemetryService} recover the title
   * via the real chat-session id. Only UUID-shaped ids are kept — a `call_…`
   * spawn id is a sub-agent anchor, not a chat session. First UUID wins per key.
   */
  chatSessionIdBySessionKey(): Map<string, string> {
    const rows = this.allRows<{ sk: string; chat: string }>(
      `SELECT DISTINCT COALESCE(conversation_id, chat_session_id) AS sk,
                chat_session_id AS chat
         FROM spans
         WHERE chat_session_id IS NOT NULL
           AND COALESCE(conversation_id, chat_session_id) IS NOT NULL`,
    );

    const map = new Map<string, string>();
    for (const row of rows) {
      if (!UUID_RE.test(row.chat)) {
        continue;
      }
      if (!map.has(row.sk)) {
        map.set(row.sk, row.chat.toLowerCase());
      }
    }
    return map;
  }

  /**
   * LOCAL-ONLY session titles archived into this store's `session_titles`
   * sidecar at sweep time (see {@link ../otel/copilotArchiver.CopilotArchiver})
   * — present only in the extension's durable archive; Copilot's native DB has
   * no such table, so this returns an empty map there. Like every other title
   * surface, the values never reach the aggregate/sync path.
   */
  readArchivedSessionTitles(): Map<string, SessionTitleInfo> {
    const titles = new Map<string, SessionTitleInfo>();
    let rows: Array<{ id: string; title: string; derived: number }>;
    try {
      rows = this.allRows<{ id: string; title: string; derived: number }>(
        'SELECT chat_session_id AS id, title, derived FROM session_titles',
      );
    } catch {
      return titles; // no sidecar table — a native Copilot DB
    }
    for (const row of rows) {
      if (typeof row.id === 'string' && typeof row.title === 'string' && row.title.length > 0) {
        titles.set(row.id, { title: row.title, derived: row.derived !== 0 });
      }
    }
    return titles;
  }

  /**
   * Representative model per session key using the uniform resolution rule
   * COALESCE(response_model, request_model) (matching getOverviewMetrics and the
   * schema mapping doc §9.1), taking the latest span's model. The `sessions`
   * view only exposes response_model, so deriving here keeps the model shown in
   * Overview, repository, and session listings consistent. Sessions whose spans
   * carry no model are absent (callers default to 'unknown').
   */
  private modelBySession(): Map<string, string> {
    if (this.modelCache !== undefined) {
      return this.modelCache;
    }
    const rows = this.allRows<{
      sk: string;
      response_model: string | null;
      request_model: string | null;
    }>(
      `SELECT COALESCE(conversation_id, chat_session_id) AS sk,
                response_model, request_model
         FROM spans
         WHERE COALESCE(conversation_id, chat_session_id) IS NOT NULL
           AND (response_model IS NOT NULL OR request_model IS NOT NULL)
         ORDER BY start_time_ms ASC, span_id ASC`,
    );

    // Iterating in ascending time means the last write per session wins (latest).
    const map = new Map<string, string>();
    for (const row of rows) {
      const model = resolveModel(row.response_model, row.request_model);
      if (model !== 'unknown') {
        map.set(row.sk, model);
      }
    }
    this.modelCache = map;
    return map;
  }

  /**
   * Distinct mapped agent modes per session key, read from the sparse
   * `copilot_chat.mode_name` attribute. Sessions with no mode attribute are
   * absent from the map (callers default to `['default']`).
   */
  private agentModesBySession(): Map<string, AgentMode[]> {
    if (this.modesCache !== undefined) {
      return this.modesCache;
    }
    const rows = this.allRows<{ session_id: string; mode_name: string | null }>(
      `SELECT DISTINCT COALESCE(s.conversation_id, s.chat_session_id) AS session_id,
                a.value AS mode_name
         FROM spans s
         JOIN span_attributes a
           ON a.span_id = s.span_id
          AND a.key = 'copilot_chat.mode_name'
         WHERE COALESCE(s.conversation_id, s.chat_session_id) IS NOT NULL`,
    );

    const map = new Map<string, Set<AgentMode>>();
    for (const row of rows) {
      const mode = mapAgentMode(row.mode_name);
      let set = map.get(row.session_id);
      if (set === undefined) {
        set = new Set<AgentMode>();
        map.set(row.session_id, set);
      }
      set.add(mode);
    }

    const result = new Map<string, AgentMode[]>();
    for (const [session, set] of map) {
      result.set(session, [...set].sort());
    }
    this.modesCache = result;
    return result;
  }

  // ─── Context-analysis queries (LOCAL-ONLY) ───────────────────────────

  /**
   * Discovery and customization-resolution event details for the whole agent tree
   * rooted at `sessionKey`. Returns the span name (e.g. "Instructions Discovery",
   * "Resolve Customizations") and the event_details string that lists loaded/skipped
   * files. Scoped to `core_event` spans carrying `copilot_chat.event_category` ∈
   * {discovery, customization}.
   *
   * LOCAL-ONLY: for on-machine context analysis only — never logged or uploaded.
   */
  getContextDiscoveryEvents(sessionKey: string): Array<{
    spanName: string;
    eventDetails: string;
    eventCategory: string;
    conversationId: string | null;
    chatSessionId: string | null;
    agentName: string | null;
    debugLabel: string | null;
  }> {
    const ids = this.sessionTreeIds(sessionKey);
    if (ids.length === 0) {
      return [];
    }
    const inList = ids.map(() => '?').join(', ');
    // The `name` column is optional (not in the required schema); fall back to
    // empty string when absent so the parser infers the type from event_details.
    const nameCol = this.spansColumns().has('name') ? 's.name' : "''";

    // Discovery/customization spans may not carry conversation_id/chat_session_id
    // (they are session-level core_events). To find them we also match spans that
    // share a trace_id with the session's known spans.
    const traceIds = this.allRows<{ trace_id: string }>(
      `SELECT DISTINCT trace_id FROM spans
         WHERE (conversation_id IN (${inList}) OR chat_session_id IN (${inList}))
           AND trace_id IS NOT NULL`,
      [...ids, ...ids],
    ).map((r) => r.trace_id);

    // Build a combined condition: conversation/session id match OR trace_id match
    const traceInList = traceIds.length > 0 ? traceIds.map(() => '?').join(', ') : "''";
    const traceCondition = traceIds.length > 0
      ? `OR s.trace_id IN (${traceInList})`
      : '';

    return this.allRows<{
      spanName: string;
      eventDetails: string;
      eventCategory: string;
      conversationId: string | null;
      chatSessionId: string | null;
      agentName: string | null;
      debugLabel: string | null;
    }>(
      `SELECT ${nameCol} AS spanName,
              det.value AS eventDetails,
              cat.value AS eventCategory,
              s.conversation_id AS conversationId,
              s.chat_session_id AS chatSessionId,
              s.agent_name AS agentName,
              lbl.value AS debugLabel
         FROM spans s
         JOIN span_attributes cat
           ON cat.span_id = s.span_id AND cat.key = 'copilot_chat.event_category'
         JOIN span_attributes det
           ON det.span_id = s.span_id AND det.key = 'copilot_chat.event_details'
         LEFT JOIN span_attributes lbl
           ON lbl.span_id = s.span_id AND lbl.key = 'copilot_chat.debug_log_label'
         WHERE (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}) ${traceCondition})
           AND cat.value IN ('discovery', 'customization')
         ORDER BY s.start_time_ms ASC`,
      [...ids, ...ids, ...traceIds],
    );
  }

  /**
   * File-reading tool calls within the agent tree that target context-file paths
   * (`.github/`, `.copilot/`, `.claude/`, `.agents/`, `AppData/Roaming/Code/User/prompts`).
   * Returns the parsed filePath from the tool-call arguments JSON.
   *
   * LOCAL-ONLY: raw tool arguments are read and parsed here; only the file path
   * string is returned. Never logged or uploaded.
   */
  getContextToolReads(sessionKey: string): Array<{
    filePath: string;
    conversationId: string | null;
    chatSessionId: string | null;
    agentName: string | null;
    debugLabel: string | null;
  }> {
    const ids = this.sessionTreeIds(sessionKey);
    if (ids.length === 0) {
      return [];
    }
    const inList = ids.map(() => '?').join(', ');
    const rows = this.allRows<{
      value: string;
      conversationId: string | null;
      chatSessionId: string | null;
      agentName: string | null;
      debugLabel: string | null;
    }>(
      `SELECT a.value AS value,
              s.conversation_id AS conversationId,
              s.chat_session_id AS chatSessionId,
              s.agent_name AS agentName,
              lbl.value AS debugLabel
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
         LEFT JOIN span_attributes lbl
           ON lbl.span_id = s.span_id AND lbl.key = 'copilot_chat.debug_log_label'
         WHERE a.key = 'gen_ai.tool.call.arguments'
           AND s.operation_name = 'execute_tool'
           AND s.tool_name = 'read_file'
           AND (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))`,
      [...ids, ...ids],
    );

    const results: Array<{
      filePath: string;
      conversationId: string | null;
      chatSessionId: string | null;
      agentName: string | null;
      debugLabel: string | null;
    }> = [];

    const contextPathPatterns = [
      '.github/',
      '.copilot/',
      '.claude/',
      '.agents/',
      'AppData/Roaming/Code/User/prompts',
      'AppData\\Roaming\\Code\\User\\prompts',
    ];

    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.value) as { filePath?: string };
        if (parsed.filePath) {
          const normalized = parsed.filePath.replace(/\\/g, '/');
          if (contextPathPatterns.some((p) => normalized.includes(p))) {
            results.push({
              filePath: parsed.filePath,
              conversationId: row.conversationId,
              chatSessionId: row.chatSessionId,
              agentName: row.agentName,
              debugLabel: row.debugLabel,
            });
          }
        }
      } catch {
        // Malformed JSON — skip silently.
      }
    }
    return results;
  }

  /**
   * Raw `gen_ai.system_instructions` text per LLM span across the agent tree,
   * keyed by span_id. Each chat/invoke_agent span may carry the full system prompt
   * that was sent to the model for that turn. Used to estimate per-file token
   * usage within the context window.
   *
   * LOCAL-ONLY: raw content for on-machine analysis — never logged or uploaded.
   */
  getSystemInstructionsBySpan(sessionKey: string): Map<string, {
    value: string;
    conversationId: string | null;
    chatSessionId: string | null;
    inputTokens: number;
    agentName: string | null;
    debugLabel: string | null;
  }> {
    const ids = this.sessionTreeIds(sessionKey);
    if (ids.length === 0) {
      return new Map();
    }
    const inList = ids.map(() => '?').join(', ');
    const rows = this.allRows<{
      span_id: string;
      value: string | null;
      conversation_id: string | null;
      chat_session_id: string | null;
      input_tokens: number | null;
      agent_name: string | null;
      debug_label: string | null;
    }>(
      `SELECT a.span_id AS span_id, a.value AS value,
              s.conversation_id AS conversation_id, s.chat_session_id AS chat_session_id,
              s.input_tokens AS input_tokens,
              s.agent_name AS agent_name,
              lbl.value AS debug_label
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
         LEFT JOIN span_attributes lbl
           ON lbl.span_id = s.span_id AND lbl.key = 'copilot_chat.debug_log_label'
         WHERE a.key = 'gen_ai.system_instructions'
           AND s.operation_name IN ('chat', 'invoke_agent')
           AND (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))
         ORDER BY s.start_time_ms ASC`,
      [...ids, ...ids],
    );

    const map = new Map<string, {
      value: string;
      conversationId: string | null;
      chatSessionId: string | null;
      inputTokens: number;
      agentName: string | null;
      debugLabel: string | null;
    }>();
    for (const row of rows) {
      if (row.value !== null && row.value.length > 0) {
        map.set(row.span_id, {
          value: row.value,
          conversationId: row.conversation_id,
          chatSessionId: row.chat_session_id,
          inputTokens: row.input_tokens ?? 0,
          agentName: row.agent_name,
          debugLabel: row.debug_label,
        });
      }
    }
    return map;
  }

  /**
   * Map from session identifiers to the friendly agent name for each subagent in
   * the session tree. Uses the exact same classification logic as
   * {@link treeUsageRollups} (Overview tab) — a chat span is a subagent turn when
   * it has `copilot_chat.debug_log_label` starting with `runSubagent-` or
   * `agent_name` starting with `tool/runSubagent`. For each subagent, maps BOTH
   * `conversation_id` and `chat_session_id` from its spans so the context analyzer
   * can look up by whichever id its discovery events carry.
   *
   * LOCAL-ONLY: no content is returned — only agent identity labels.
   */
  getSubagentNames(sessionKey: string): Map<string, string> {
    const ids = this.sessionTreeIds(sessionKey);
    if (ids.length === 0) {
      return new Map();
    }
    const inList = ids.map(() => '?').join(', ');

    // Select ALL chat spans in the tree (no subagent filter in WHERE — same as
    // treeUsageRollups). Classify each in JS to avoid filter mismatch.
    const rows = this.allRows<{
      conversation_id: string | null;
      chat_session_id: string | null;
      agent_name: string | null;
      debug_label: string | null;
    }>(
      `SELECT s.conversation_id AS conversation_id,
              s.chat_session_id AS chat_session_id,
              s.agent_name AS agent_name,
              lbl.value AS debug_label
         FROM spans s
         LEFT JOIN span_attributes lbl
           ON lbl.span_id = s.span_id AND lbl.key = 'copilot_chat.debug_log_label'
        WHERE s.operation_name = 'chat'
          AND (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))`,
      [...ids, ...ids],
    );

    const map = new Map<string, string>();
    for (const row of rows) {
      // Same classification as treeUsageRollups:
      const isSubagent =
        (row.debug_label !== null && row.debug_label.startsWith('runSubagent-')) ||
        (row.agent_name !== null && row.agent_name.startsWith('tool/runSubagent'));
      if (!isSubagent) {
        continue;
      }
      const name = friendlyAgentName('subagent', row.agent_name, row.debug_label);
      if (row.conversation_id !== null && !map.has(row.conversation_id)) {
        map.set(row.conversation_id, name);
      }
      if (row.chat_session_id !== null && !map.has(row.chat_session_id)) {
        map.set(row.chat_session_id, name);
      }
    }

    // Propagate: discovery events within a subagent scope may use different ids
    // than the chat spans. Walk all spans reachable from known subagent ids
    // (bounded BFS, same approach as sessionTreeIds) and map their co-occurring
    // ids. This bridges the gap between chat span ids and core_event/discovery
    // span ids within the same subagent's scope.
    if (map.size > 0) {
      let frontier = [...map.keys()];
      const visited = new Set(frontier);
      for (let hop = 0; hop < 3 && frontier.length > 0; hop++) {
        const frontierInList = frontier.map(() => '?').join(', ');
        const linkedRows = this.allRows<{
          conversation_id: string | null;
          chat_session_id: string | null;
        }>(
          `SELECT DISTINCT conversation_id, chat_session_id
             FROM spans
             WHERE conversation_id IN (${frontierInList})
                OR chat_session_id IN (${frontierInList})`,
          [...frontier, ...frontier],
        );
        const nextFrontier: string[] = [];
        for (const row of linkedRows) {
          const nameFromConv = row.conversation_id !== null ? map.get(row.conversation_id) : undefined;
          const nameFromCsid = row.chat_session_id !== null ? map.get(row.chat_session_id) : undefined;
          const name = nameFromConv ?? nameFromCsid;
          if (name !== undefined) {
            if (row.conversation_id !== null && !visited.has(row.conversation_id)) {
              map.set(row.conversation_id, name);
              visited.add(row.conversation_id);
              nextFrontier.push(row.conversation_id);
            }
            if (row.chat_session_id !== null && !visited.has(row.chat_session_id)) {
              map.set(row.chat_session_id, name);
              visited.add(row.chat_session_id);
              nextFrontier.push(row.chat_session_id);
            }
          }
        }
        frontier = nextFrontier;
      }
    }

    // Remove the root session key to avoid labelling the main partition.
    map.delete(sessionKey);

    return map;
  }

  /**
   * Set of session keys that have STARTED — i.e. carry at least one span —
   * excluding sessions that used only inline-suggestion models.
   *
   * Unlike a stricter "human-initiated" gate, this deliberately does NOT require a
   * `copilot_chat.user_request` span. A just-started session emits an
   * `execute_tool`/`execute_hook` span first and only lands its user-request span
   * 7-33s later; keying presence on "any span" surfaces the session in the list
   * that much sooner. Suggestion-only (inline completion) sessions have no real
   * chat model and are still excluded — a session with no chat spans yet is absent
   * from that exclusion set and thus admitted.
   *
   * TWO span shapes qualify, because the emitters differ:
   *
   * (a) VS Code Copilot Chat — a UUID `chat_session_id`. Because the `sessions`
   *     view groups by `COALESCE(conversation_id, chat_session_id)`, only rows
   *     where that key equals the bare `chat_session_id` match, so per-turn
   *     `conversation_id` fragments (including spawned sub-agents, whose spans
   *     carry the parent's `chat_session_id`) are naturally excluded.
   *
   * (b) Autonomous Copilot CLI agents — NO `chat_session_id` at all; the whole run
   *     shares one `gen_ai.conversation.id`, which IS the session. Such a session
   *     is admitted by its UUID session key, but ONLY when none of its spans carry
   *     a `chat_session_id` — that condition is what keeps (a)'s per-turn
   *     conversation fragments out, since those always carry the parent's id —
   *     AND at least one span is an agent-run span (`invoke_agent` /
   *     `execute_tool` / `execute_hook`). Chat-helper telemetry (Next Edit
   *     Suggestions, `copilotLanguageModelWrapper`, commit-message/title/progress
   *     generators) emits conversation-keyed `chat` spans only and must never
   *     surface as sessions; `execute_tool` spans end promptly DURING a run, so a
   *     live autonomous session still appears by its first tool call. A
   *     hypothetical autonomous run that only ever emits `chat` spans stays
   *     hidden — it is shape-indistinguishable from the helper noise. Without
   *     shape (b), every relayed autonomous session was silently absent from
   *     the Sessions tree and the repository rollup.
   */
  private startedSessionIds(): ReadonlySet<string> {
    if (this.startedSessionsCache !== undefined) {
      return this.startedSessionsCache;
    }
    type KeyRow = { session_key: string };
    const chatSessionCandidates = this.allRows<KeyRow>(CHAT_SESSION_CANDIDATES_SQL);
    const conversationOnlyCandidates = this.allRows<KeyRow>(CONVERSATION_ONLY_CANDIDATES_SQL);

    // Suggestion-only exclusion, applied per shape with its own key (grouping the
    // Copilot Chat case by the session key instead would break it, because its
    // rows are keyed by per-turn conversation ids).
    const suggestionOnlyByChatSession = this.suggestionOnlySessions('chat_session_id');
    const suggestionOnlyByKey =
      conversationOnlyCandidates.length > 0
        ? this.suggestionOnlySessions(SESSION_KEY_EXPR)
        : NO_SESSIONS;

    this.startedSessionsCache = startedSessionSet(
      chatSessionCandidates,
      conversationOnlyCandidates,
      suggestionOnlyByChatSession,
      suggestionOnlyByKey,
    );
    return this.startedSessionsCache;
  }

  /**
   * Session keys (grouped by `keyExpr`) whose CHAT spans use ONLY inline-
   * suggestion models — i.e. no real chat model. Sessions with no chat spans yet
   * are absent from the result and are therefore admitted by the caller.
   *
   * `keyExpr` is a fixed SQL expression from this module (never user input).
   */
  private suggestionOnlySessions(keyExpr: string): ReadonlySet<string> {
    return new Set(
      this.allRows<{ session_key: string }>(suggestionOnlySql(keyExpr)).map((r) => r.session_key),
    );
  }
}

/**
 * Display-only "fresh" (non-cache-read) input for a Copilot/OTel `chat` span.
 *
 * Copilot reports `gen_ai.usage.input_tokens` as the GROSS prompt count with the
 * cache-read tokens FOLDED IN, and `cached_tokens` (= `cache_read.input_tokens`)
 * as a subset of it. The detail view shows TIN/TCI as DISJOINT buckets — matching
 * the Claude path, where the API reports uncached input separately from cache reads
 * — so TIN must exclude the cache-read portion. Subtract it here, clamped at 0
 * (cached is always ≤ gross input in practice).
 *
 * This is a DISPLAY normalization only: the stored `spans.input_tokens` and the
 * cloud-aggregation path ({@link ../aggregate/aggregator}) keep the gross value,
 * which is the documented OTel/`prompt_tokens` convention.
 */
function freshInput(grossInput: number, cached: number): number {
  return Math.max(0, grossInput - cached);
}

/** Resolve a model id: response_model, then request_model, else `unknown`. */
function resolveModel(response: string | null, request: string | null): string {
  if (response !== null && response.length > 0) {
    return response;
  }
  if (request !== null && request.length > 0) {
    return request;
  }
  return 'unknown';
}

/**
 * Friendly label for an agent in the tree-scoped usage breakdown. The main thread
 * is `Main agent`. A spawned sub-agent's identity comes from its
 * `copilot_chat.debug_log_label` (`runSubagent-<Name>`), which is consistent where
 * the `agent_name` column is not; `runSubagent-default` is Copilot's unnamed
 * sub-agent, so its suffix is dropped. Falls back to the raw `agent_name` (else a
 * generic `Sub-agent`) when no usable label is present.
 */
function friendlyAgentName(
  kind: 'main' | 'subagent',
  agentName: string | null,
  debugLabel: string | null,
): string {
  if (kind === 'main') {
    return 'Main agent';
  }
  const match = /^runSubagent-(.+)$/.exec(debugLabel ?? '');
  if (match !== null) {
    const name = match[1];
    return name === 'default' ? 'Sub-agent' : `Sub-agent: ${name}`;
  }
  if (agentName !== null && agentName.length > 0) {
    return agentName;
  }
  return 'Sub-agent';
}

/**
 * Classify a chat span as main or subagent using the same rule the Overview tab
 * uses: subagent if `debug_log_label` starts with `runSubagent-` or `agent_name`
 * starts with `tool/runSubagent`; otherwise main. Returns the friendly agent
 * name (e.g. "Sub-agent: Backend" or "Main agent"). Exported so the context
 * analyzer can classify identically.
 */
export function classifyAgentSpan(
  agentName: string | null,
  debugLabel: string | null,
): { kind: 'main' | 'subagent'; friendlyName: string } {
  const safeAgent = agentName ?? null;
  const safeLabel = debugLabel ?? null;
  const isSubagent =
    (safeLabel !== null && safeLabel.startsWith('runSubagent-')) ||
    (safeAgent !== null && safeAgent.startsWith('tool/runSubagent'));
  const kind: 'main' | 'subagent' = isSubagent ? 'subagent' : 'main';
  return { kind, friendlyName: friendlyAgentName(kind, safeAgent, safeLabel) };
}
