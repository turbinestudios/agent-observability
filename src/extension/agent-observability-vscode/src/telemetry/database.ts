import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import { RepositoryResolver } from './repositoryResolver';
import { AggregationRow } from '../aggregate/aggregator';
import { mapToolName } from '../aggregate/builtinTools';
import {
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionSummary,
  SessionDetail,
  SessionTimelineEntry,
  AgentMode,
  mapAgentMode,
  statusToSuccess,
} from './models';

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

/**
 * Read-only wrapper over a snapshot-copy connection to `agent-traces.db`.
 *
 * Opened with `{ readonly: true, fileMustExist: true }` against a temp COPY
 * (see {@link createReadonlySnapshot}) so it can never mutate the real DB.
 * Validates the schema on construction and exposes safe-metadata queries; the
 * repository resolver guarantees every Session/Repository carries a sanitized
 * repository.
 */
export class TelemetryDatabase {
  private readonly db: DatabaseType;
  private resolverCache: RepositoryResolver | undefined;
  private spansColumnsCache: ReadonlySet<string> | undefined;

  private constructor(db: DatabaseType) {
    this.db = db;
  }

  /**
   * Open the snapshot copy read-only and validate its schema.
   *
   * @throws SchemaMismatchError when the file is not a supported telemetry DB.
   * @throws the underlying better-sqlite3 error (e.g. ENOENT) when the file is
   *   missing or unreadable — the service layer classifies these.
   */
  static open(snapshotDbPath: string): TelemetryDatabase {
    const db = new Database(snapshotDbPath, { readonly: true, fileMustExist: true });
    const instance = new TelemetryDatabase(db);
    try {
      instance.validateSchema();
    } catch (err) {
      instance.close();
      throw err;
    }
    return instance;
  }

  /** Close the underlying connection. Idempotent-safe via better-sqlite3. */
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
      const row = this.db
        .prepare('SELECT version FROM schema_version LIMIT 1')
        .get() as { version: number } | undefined;
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
      (this.db.prepare("PRAGMA table_info('spans')").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
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
    const row = this.db
      .prepare('SELECT type FROM sqlite_master WHERE name = ? LIMIT 1')
      .get(name) as { type: string } | undefined;
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
    return this.resolverCache;
  }

  /**
   * Cached set of `spans` column names. Used to tolerate optional, provider-
   * specific columns (e.g. `reasoning_tokens`) that a valid schema-v1 DB may
   * omit — selecting a missing column would otherwise throw at query time.
   */
  private spansColumns(): ReadonlySet<string> {
    if (this.spansColumnsCache === undefined) {
      this.spansColumnsCache = new Set(
        (this.db.prepare("PRAGMA table_info('spans')").all() as Array<{ name: string }>).map(
          (c) => c.name,
        ),
      );
    }
    return this.spansColumnsCache;
  }

  /**
   * Overview metrics across all spans (optionally since `sinceMs`, inclusive
   * on `start_time_ms`). Distinct repositories/models are computed in JS using
   * the resolver so the sanitized repository (not the raw URL) is the dimension.
   */
  getOverviewMetrics(sinceMs?: number): OverviewMetrics {
    const where = sinceMs !== undefined ? 'WHERE start_time_ms >= ?' : '';
    const params = sinceMs !== undefined ? [sinceMs] : [];

    const agg = this.db
      .prepare(
        `SELECT
           COUNT(*) AS total_interactions,
           COUNT(DISTINCT COALESCE(conversation_id, chat_session_id)) AS total_sessions,
           AVG(end_time_ms - start_time_ms) AS avg_duration_ms,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(input_tokens, 0) ELSE 0 END) AS input_tokens,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(output_tokens, 0) ELSE 0 END) AS output_tokens,
           SUM(CASE WHEN operation_name = 'chat' THEN COALESCE(cached_tokens, 0) ELSE 0 END) AS cached_tokens,
           SUM(CASE WHEN status_code = 2 THEN 1 ELSE 0 END) AS error_count
         FROM spans ${where}`,
      )
      .get(...params) as {
      total_interactions: number;
      total_sessions: number;
      avg_duration_ms: number | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
      error_count: number | null;
    };

    // Distinct models from the typed columns (safe metadata).
    const modelRows = this.db
      .prepare(
        `SELECT DISTINCT COALESCE(response_model, request_model) AS model
         FROM spans ${where}`,
      )
      .all(...params) as Array<{ model: string | null }>;
    const models = new Set<string>();
    for (const r of modelRows) {
      if (r.model !== null && r.model.length > 0) {
        models.add(r.model);
      }
    }

    // Distinct sanitized repositories across the session keys in range.
    const sessionRows = this.db
      .prepare(
        `SELECT DISTINCT COALESCE(conversation_id, chat_session_id) AS sk
         FROM spans ${where}`,
      )
      .all(...params) as Array<{ sk: string | null }>;
    const resolver = this.resolver();
    const repositories = new Set<string>();
    for (const r of sessionRows) {
      repositories.add(resolver.resolve(r.sk));
    }

    return {
      totalInteractions: agg.total_interactions,
      totalSessions: agg.total_sessions,
      totalRepositories: repositories.size,
      totalModels: models.size,
      avgDurationMs: agg.avg_duration_ms === null ? 0 : Math.round(agg.avg_duration_ms),
      inputTokens: agg.input_tokens ?? 0,
      outputTokens: agg.output_tokens ?? 0,
      cachedTokens: agg.cached_tokens ?? 0,
      errorCount: agg.error_count ?? 0,
    };
  }

  /**
   * One {@link RepositorySummary} per distinct sanitized repository, ordered by
   * most-recent activity. Aggregates the `sessions` view by resolved repository.
   */
  listRepositories(): RepositorySummary[] {
    const resolver = this.resolver();
    const modelBySession = this.modelBySession();

    interface Acc {
      repository: string;
      sessionCount: number;
      interactionCount: number;
      models: Set<string>;
      lastActivityMs: number;
    }
    const byRepo = new Map<string, Acc>();

    const rows = this.db
      .prepare(
        `SELECT session_id, ended_at, span_count
         FROM sessions`,
      )
      .all() as Array<{
      session_id: string;
      ended_at: number;
      span_count: number;
    }>;

    for (const row of rows) {
      const repository = resolver.resolve(row.session_id);
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

    const rows = this.db
      .prepare(
        `SELECT session_id, agent_name, started_at, ended_at, duration_ms,
                span_count, llm_calls, tool_calls,
                total_input_tokens, total_output_tokens, total_cached_tokens
         FROM sessions
         ORDER BY started_at DESC`,
      )
      .all() as Array<{
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
    }>;

    // Agent modes + representative model per session (consistent resolution).
    const modesBySession = this.agentModesBySession();
    const modelBySession = this.modelBySession();

    const summaries: SessionSummary[] = [];
    for (const row of rows) {
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
        inputTokens: row.total_input_tokens ?? 0,
        outputTokens: row.total_output_tokens ?? 0,
        cachedTokens: row.total_cached_tokens ?? 0,
        model: modelBySession.get(row.session_id) ?? 'unknown',
        agentModes: modesBySession.get(row.session_id) ?? ['default'],
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

    const rows = this.db
      .prepare(
        `SELECT span_id, trace_id, start_time_ms, end_time_ms, status_code,
                operation_name, agent_name, request_model, response_model,
                tool_name, input_tokens, output_tokens, cached_tokens
         FROM spans
         WHERE COALESCE(conversation_id, chat_session_id) = ?
         ORDER BY start_time_ms ASC, span_id ASC`,
      )
      .all(sessionKey) as Array<{
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
    }>;

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

    const rows = this.db
      .prepare(
        `SELECT COALESCE(conversation_id, chat_session_id) AS session_key,
                start_time_ms, end_time_ms, status_code, operation_name,
                response_model, request_model, tool_name,
                input_tokens, output_tokens, cached_tokens, ${reasoningCol}
         FROM spans
         ${where}
         ORDER BY start_time_ms ASC, span_id ASC`,
      )
      .all(...params) as Array<{
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
    }>;

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
        model: resolveModel(row.response_model, row.request_model),
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
   * PRIVACY: this is the ONLY query that reads raw content. For `chat` spans it
   * additionally reads the `copilot_chat.user_request` attribute into
   * {@link SessionTimelineEntry.userRequest}. The caller renders it locally
   * (HTML-escaped) and never logs or uploads it. All other metadata methods on
   * this class stay strictly content-free.
   *
   * Returns `undefined` when the session key has no spans.
   */
  getSessionDetail(sessionKey: string): SessionDetail | undefined {
    const resolver = this.resolver();
    const repository = resolver.resolve(sessionKey);

    const rows = this.db
      .prepare(
        `SELECT span_id, start_time_ms, end_time_ms, status_code,
                operation_name, request_model, response_model, tool_name,
                input_tokens, output_tokens, cached_tokens
         FROM spans
         WHERE COALESCE(conversation_id, chat_session_id) = ?
         ORDER BY start_time_ms ASC, span_id ASC`,
      )
      .all(sessionKey) as Array<{
      span_id: string;
      start_time_ms: number;
      end_time_ms: number;
      status_code: number;
      operation_name: string | null;
      request_model: string | null;
      response_model: string | null;
      tool_name: string | null;
      input_tokens: number | null;
      output_tokens: number | null;
      cached_tokens: number | null;
    }>;

    if (rows.length === 0) {
      return undefined;
    }

    // LOCAL-ONLY raw user requests, keyed by span id, scoped to chat spans.
    const userRequests = this.userRequestsBySpan(sessionKey);
    const mode = this.agentModesBySession().get(sessionKey)?.[0] ?? 'default';

    let startedAtMs = rows[0].start_time_ms;
    let endedAtMs = rows[0].end_time_ms;
    let llmCalls = 0;
    let toolCalls = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let cachedTokens = 0;

    const timeline: SessionTimelineEntry[] = rows.map((row) => {
      const operation = row.operation_name ?? 'chat';
      if (operation === 'chat') {
        llmCalls += 1;
      } else if (operation === 'execute_tool') {
        toolCalls += 1;
      }
      inputTokens += row.input_tokens ?? 0;
      outputTokens += row.output_tokens ?? 0;
      cachedTokens += row.cached_tokens ?? 0;
      if (row.start_time_ms < startedAtMs) {
        startedAtMs = row.start_time_ms;
      }
      if (row.end_time_ms > endedAtMs) {
        endedAtMs = row.end_time_ms;
      }

      // user_request is read for chat spans only (privacy-scoped, local display).
      const userRequest =
        operation === 'chat' ? userRequests.get(row.span_id) : undefined;

      return {
        timestampMs: row.start_time_ms,
        operation,
        agentMode: mode,
        model: resolveModel(row.response_model, row.request_model),
        toolName:
          row.tool_name !== null && row.tool_name.length > 0 ? row.tool_name : undefined,
        durationMs: row.end_time_ms - row.start_time_ms,
        success: statusToSuccess(row.status_code),
        userRequest,
      };
    });

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
      agentModes: this.agentModesBySession().get(sessionKey) ?? ['default'],
    };

    return { summary, timeline };
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
    const rows = this.db
      .prepare(
        `SELECT a.span_id AS span_id, a.value AS value
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
         WHERE a.key = ?
           AND COALESCE(s.conversation_id, s.chat_session_id) = ?`,
      )
      .all(attributeKey, sessionKey) as Array<{ span_id: string; value: string | null }>;

    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.value !== null) {
        map.set(row.span_id, row.value);
      }
    }
    return map;
  }

  /**
   * LOCAL-ONLY: map span id → raw `copilot_chat.user_request` value for the chat
   * spans of a single session. Used solely by {@link getSessionDetail} for local
   * webview display; never logged or uploaded. Only chat spans are included so
   * the value is surfaced exactly where the detail view shows a user prompt.
   */
  private userRequestsBySpan(sessionKey: string): Map<string, string> {
    const rows = this.db
      .prepare(
        `SELECT a.span_id AS span_id, a.value AS value
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
         WHERE a.key = 'copilot_chat.user_request'
           AND s.operation_name = 'chat'
           AND COALESCE(s.conversation_id, s.chat_session_id) = ?`,
      )
      .all(sessionKey) as Array<{ span_id: string; value: string | null }>;

    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.value !== null && row.value.length > 0) {
        map.set(row.span_id, row.value);
      }
    }
    return map;
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
    const rows = this.db
      .prepare(
        `SELECT COALESCE(conversation_id, chat_session_id) AS sk,
                response_model, request_model
         FROM spans
         WHERE COALESCE(conversation_id, chat_session_id) IS NOT NULL
           AND (response_model IS NOT NULL OR request_model IS NOT NULL)
         ORDER BY start_time_ms ASC, span_id ASC`,
      )
      .all() as Array<{ sk: string; response_model: string | null; request_model: string | null }>;

    // Iterating in ascending time means the last write per session wins (latest).
    const map = new Map<string, string>();
    for (const row of rows) {
      const model = resolveModel(row.response_model, row.request_model);
      if (model !== 'unknown') {
        map.set(row.sk, model);
      }
    }
    return map;
  }

  /**
   * Distinct mapped agent modes per session key, read from the sparse
   * `copilot_chat.mode_name` attribute. Sessions with no mode attribute are
   * absent from the map (callers default to `['default']`).
   */
  private agentModesBySession(): Map<string, AgentMode[]> {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT COALESCE(s.conversation_id, s.chat_session_id) AS session_id,
                a.value AS mode_name
         FROM spans s
         JOIN span_attributes a
           ON a.span_id = s.span_id
          AND a.key = 'copilot_chat.mode_name'
         WHERE COALESCE(s.conversation_id, s.chat_session_id) IS NOT NULL`,
      )
      .all() as Array<{ session_id: string; mode_name: string | null }>;

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
    return result;
  }
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
