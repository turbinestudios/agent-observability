import { Database } from 'node-sqlite3-wasm';
import type { BindValues } from 'node-sqlite3-wasm';
import { RepositoryResolver } from './repositoryResolver';
import { UNKNOWN_REPOSITORY } from './repositoryUrl';
import { AggregationRow } from '../aggregate/aggregator';
import { mapToolName } from '../aggregate/builtinTools';
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
import { extractResponseText } from './responseText';
import { countWrittenLines, sumWrittenLines, WriteLineDelta } from './locAnalysis';

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

/**
 * A whole-string UUID. Distinguishes a real chat-session id (joinable to the
 * LOCAL title store) from a `call_…` sub-agent spawn id in `chat_session_id`.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
 * Read-only wrapper over a snapshot-copy connection to `agent-traces.db`.
 *
 * Opened with `{ readonly: true, fileMustExist: true }` against a temp COPY
 * (see {@link createReadonlySnapshot}) so it can never mutate the real DB.
 * Validates the schema on construction and exposes safe-metadata queries; the
 * repository resolver guarantees every Session/Repository carries a sanitized
 * repository.
 */
export class TelemetryDatabase {
  private readonly db: Database;
  private resolverCache: RepositoryResolver | undefined;
  private spansColumnsCache: ReadonlySet<string> | undefined;
  private humanSessionsCache: ReadonlySet<string> | undefined;

  private constructor(db: Database) {
    this.db = db;
  }

  /**
   * Run a single-row query via the auto-finalizing convenience method and
   * normalize node-sqlite3-wasm's `null` (no row) to `undefined` so callers can
   * keep using `=== undefined` checks. `db.get`/`db.all` finalize the internal
   * prepared statement for us — unlike a raw `db.prepare(...)`, which would leak
   * WASM memory since `db.close()` does not finalize pending statements.
   */
  private getRow<T>(sql: string, params?: BindValues): T | undefined {
    const row = this.db.get(sql, params);
    return row === null ? undefined : (row as unknown as T);
  }

  /** Run a multi-row query via the auto-finalizing convenience method. */
  private allRows<T>(sql: string, params?: BindValues): T[] {
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
        this.allRows<{ name: string }>("PRAGMA table_info('spans')").map((c) => c.name),
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
      inputTokens: agg.input_tokens ?? 0,
      outputTokens: agg.output_tokens ?? 0,
      cachedTokens: agg.cached_tokens ?? 0,
      errorCount: agg.error_count ?? 0,
    };
  }

  /**
   * The distinct resolved model ids and sanitized repositories across all
   * spans (optionally since `sinceMs`, inclusive on `start_time_ms`), as the
   * NAMES rather than counts — so the service layer can union them across
   * several merged databases without double-counting a model or repository
   * active in more than one environment. Safe metadata only.
   */
  getOverviewDimensions(sinceMs?: number): { models: string[]; repositories: string[] } {
    const where = sinceMs !== undefined ? 'WHERE start_time_ms >= ?' : '';
    const params = sinceMs !== undefined ? [sinceMs] : [];

    // Distinct models from the typed columns (safe metadata).
    const modelRows = this.allRows<{ model: string | null }>(
      `SELECT DISTINCT COALESCE(response_model, request_model) AS model
         FROM spans ${where}`,
      params,
    );
    const models = new Set<string>();
    for (const r of modelRows) {
      if (r.model !== null && r.model.length > 0) {
        models.add(r.model);
      }
    }

    // Distinct sanitized repositories across the session keys in range.
    const sessionRows = this.allRows<{ sk: string | null }>(
      `SELECT DISTINCT COALESCE(conversation_id, chat_session_id) AS sk
         FROM spans ${where}`,
      params,
    );
    const resolver = this.resolver();
    const repositories = new Set<string>();
    for (const r of sessionRows) {
      repositories.add(resolver.resolve(r.sk));
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

    interface Acc {
      repository: string;
      sessionCount: number;
      interactionCount: number;
      models: Set<string>;
      lastActivityMs: number;
    }
    const byRepo = new Map<string, Acc>();

    const humanSessions = this.humanInitiatedSessionIds();

    const rows = this.allRows<{
      session_id: string;
      ended_at: number;
      span_count: number;
    }>(
      `SELECT session_id, ended_at, span_count
         FROM sessions`,
    );

    for (const row of rows) {
      // Only include human-initiated sessions (has at least one chat/invoke_agent span).
      if (!humanSessions.has(row.session_id)) {
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
    const humanSessions = this.humanInitiatedSessionIds();

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
      // Only include human-initiated sessions (has at least one chat/invoke_agent span).
      if (!humanSessions.has(row.session_id)) {
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
        inputTokens += rowInput;
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
        currentTurn.inputTokens += row.input_tokens ?? 0;
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
        let idx = 0;
        for (let t = 0; t < turns.length; t++) {
          if (turns[t].timestampMs <= w.startMs) {
            idx = t;
          } else {
            break;
          }
        }
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
      agentModes: this.agentModesBySession().get(sessionKey) ?? ['default'],
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
      inputTokens: row.input_tokens ?? 0,
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
        let idx = 0;
        for (let p = 0; p < points.length; p++) {
          if (points[p].timestampMs <= w.startMs) {
            idx = p;
          } else {
            break;
          }
        }
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
    const writeLines =
      codeExts.length > 0 || docExts.length > 0
        ? sumWrittenLines(
            this.allRows<{ tool_name: string | null; value: string | null }>(
              `SELECT s.tool_name AS tool_name, a.value AS value
                 FROM span_attributes a
                 JOIN spans s ON s.span_id = a.span_id
                 WHERE a.key = ?
                   AND s.operation_name = 'execute_tool'
                   AND (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))`,
              [TOOL_ARGUMENTS_KEY, ...ids, ...ids],
            )
              .filter((r): r is { tool_name: string | null; value: string } => r.value !== null)
              .map((r) => ({ toolName: r.tool_name ?? '', argumentsJson: r.value })),
            codeExts,
            docExts,
          )
        : { added: { code: 0, doc: 0 }, removed: { code: 0, doc: 0 } };

    const inputTokens = agg.input_tokens ?? 0;
    const outputTokens = agg.output_tokens ?? 0;
    return {
      modelTurns: agg.model_turns ?? 0,
      toolCalls: agg.tool_calls ?? 0,
      inputTokens,
      outputTokens,
      cachedTokens: agg.cached_tokens ?? 0,
      totalTokens: inputTokens + outputTokens,
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
              SUM(CASE WHEN aiu.value IS NOT NULL THEN CAST(aiu.value AS INTEGER) ELSE 0 END) AS aiu_nano
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
      const input = row.input_tokens ?? 0;
      const output = row.output_tokens ?? 0;
      const cached = row.cached_tokens ?? 0;
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
          let idx = 0;
          for (let t = 0; t < turns.length; t++) {
            if (turns[t].startMs <= w.startMs) {
              idx = t;
            } else {
              break;
            }
          }
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
    return [...seen];
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

    return rows
      .filter(
        (r): r is { start_time_ms: number; tool_name: string | null; value: string } =>
          r.value !== null && r.value.length > 0,
      )
      .map((r) => ({
        startMs: r.start_time_ms,
        delta: countWrittenLines(r.tool_name ?? '', r.value, codeExts, docExts),
      }));
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
   * Representative model per session key using the uniform resolution rule
   * COALESCE(response_model, request_model) (matching getOverviewMetrics and the
   * schema mapping doc §9.1), taking the latest span's model. The `sessions`
   * view only exposes response_model, so deriving here keeps the model shown in
   * Overview, repository, and session listings consistent. Sessions whose spans
   * carry no model are absent (callers default to 'unknown').
   */
  private modelBySession(): Map<string, string> {
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
    return map;
  }

  /**
   * Distinct mapped agent modes per session key, read from the sparse
   * `copilot_chat.mode_name` attribute. Sessions with no mode attribute are
   * absent from the map (callers default to `['default']`).
   */
  private agentModesBySession(): Map<string, AgentMode[]> {
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
  }> {
    const ids = this.sessionTreeIds(sessionKey);
    if (ids.length === 0) {
      return [];
    }
    const inList = ids.map(() => '?').join(', ');
    return this.allRows<{
      spanName: string;
      eventDetails: string;
      eventCategory: string;
      conversationId: string | null;
      chatSessionId: string | null;
    }>(
      `SELECT s.name AS spanName,
              det.value AS eventDetails,
              cat.value AS eventCategory,
              s.conversation_id AS conversationId,
              s.chat_session_id AS chatSessionId
         FROM spans s
         JOIN span_attributes cat
           ON cat.span_id = s.span_id AND cat.key = 'copilot_chat.event_category'
         JOIN span_attributes det
           ON det.span_id = s.span_id AND det.key = 'copilot_chat.event_details'
         WHERE (s.conversation_id IN (${inList}) OR s.chat_session_id IN (${inList}))
           AND cat.value IN ('discovery', 'customization')
         ORDER BY s.start_time_ms ASC`,
      [...ids, ...ids],
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
    }>(
      `SELECT a.value AS value,
              s.conversation_id AS conversationId,
              s.chat_session_id AS chatSessionId
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
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
    }>(
      `SELECT a.span_id AS span_id, a.value AS value,
              s.conversation_id AS conversation_id, s.chat_session_id AS chat_session_id,
              s.input_tokens AS input_tokens
         FROM span_attributes a
         JOIN spans s ON s.span_id = a.span_id
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
    }>();
    for (const row of rows) {
      if (row.value !== null && row.value.length > 0) {
        map.set(row.span_id, {
          value: row.value,
          conversationId: row.conversation_id,
          chatSessionId: row.chat_session_id,
          inputTokens: row.input_tokens ?? 0,
        });
      }
    }
    return map;
  }

  /**
   * Set of `chat_session_id` UUIDs that correspond to entries in Copilot's chat
   * history — i.e. human-initiated chat sessions. Only UUID-shaped ids with at
   * least one `copilot_chat.user_request` span qualify, excluding sessions that
   * used only inline-suggestion models.
   *
   * Because the `sessions` view groups by `COALESCE(conversation_id,
   * chat_session_id)`, only rows where that key equals the bare `chat_session_id`
   * will match this set — per-turn `conversation_id` fragments are naturally
   * excluded.
   */
  private humanInitiatedSessionIds(): ReadonlySet<string> {
    if (this.humanSessionsCache !== undefined) {
      return this.humanSessionsCache;
    }
    // Distinct UUID chat_session_ids with at least one user_request span.
    const rows = this.allRows<{ csid: string }>(
      `SELECT DISTINCT s.chat_session_id AS csid
         FROM spans s
         JOIN span_attributes a
           ON a.span_id = s.span_id
          AND a.key = 'copilot_chat.user_request'
         WHERE s.chat_session_id IS NOT NULL
           AND LENGTH(s.chat_session_id) = 36`,
    );

    // Keep only UUID-shaped ids (excludes tool-call ids like `toolu_bdrk_*`).
    const uuidCandidates = rows
      .filter((r) => UUID_RE.test(r.csid))
      .map((r) => r.csid);

    // Sessions whose spans use ONLY inline-suggestion models (no real chat model).
    const suggestionOnlySessions = new Set(
      this.allRows<{ sk: string }>(
        `SELECT chat_session_id AS sk
           FROM spans
           WHERE chat_session_id IS NOT NULL
             AND operation_name = 'chat'
           GROUP BY chat_session_id
           HAVING SUM(CASE WHEN COALESCE(response_model, request_model) NOT LIKE '%suggestions%' THEN 1 ELSE 0 END) = 0`,
      ).map((r) => r.sk),
    );

    this.humanSessionsCache = new Set(
      uuidCandidates.filter((id) => !suggestionOnlySessions.has(id)),
    );
    return this.humanSessionsCache;
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
