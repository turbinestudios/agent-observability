/**
 * Internal telemetry model shapes and shared mapping helpers.
 *
 * These reproduce — from the **local** Copilot `agent-traces.db` — the
 * equivalent of the cloud dashboard models, per the Phase 0 schema mapping
 * table (`docs/architecture/copilot-telemetry-schema.md` §9). They carry ONLY
 * safe metadata; no raw prompt/completion/tool content ever appears here.
 *
 * Clean seams:
 * - Phase 3 reuses {@link Interaction} for the per-session detail view.
 * - Phase 5 reuses {@link statusToSuccess} / {@link mapAgentMode} and these
 *   shapes for cloud aggregation.
 */

/** OTEL operation names observed in `spans.operation_name`. */
export type Operation = 'chat' | 'execute_tool' | 'execute_hook' | 'invoke_agent';

/**
 * The fixed set of agent modes the cloud aggregate schema permits. Any
 * user-defined / custom chat mode name collapses to `custom` so project or
 * customer identifiers in a custom mode name never leak (privacy-critical;
 * see `aggregate-batch.schema.json` `agentMode`).
 */
export type AgentMode = 'default' | 'ask' | 'edit' | 'agent' | 'custom';

/**
 * One span projected to safe metadata. Maps to the cloud
 * `AgentInteraction` / `SessionInteraction` shape — but WITHOUT any raw
 * content field (`UserRequest` etc. are Phase 3, local-only, and still not
 * surfaced here).
 */
export interface Interaction {
  /** `spans.start_time_ms` (epoch ms). */
  timestampMs: number;
  /** Resolved session key: `COALESCE(conversation_id, chat_session_id)`. */
  sessionId: string;
  /** `spans.trace_id`. */
  traceId: string;
  /**
   * `spans.span_id`. Used ONLY on the local deviation path to correlate a span
   * with its raw `span_attributes` content for a {@link ../deviation/models.ContentPredicate}.
   * It is not a cloud-aggregate dimension and never reaches the sync batch (that
   * path uses the separate `AggregationRow`). Optional so synthetic test
   * interactions and metadata-only callers need not supply it.
   */
  spanId?: string;
  /** `spans.operation_name`. */
  operation: Operation | string;
  /** `spans.agent_name`, defaulting to `copilot` when absent. */
  agentName: string;
  /** Resolved agent mode (mapped to the known set). */
  agentMode: AgentMode;
  /** Resolved model id (response_model, else request_model), else `unknown`. */
  model: string;
  /** `spans.tool_name` (execute_tool spans), else `undefined`. */
  toolName?: string;
  /** `end_time_ms - start_time_ms`. */
  durationMs: number;
  /** `true` when `status_code` ∈ {0 unset, 1 ok}; `false` only for 2 (error). */
  success: boolean;
  /** `spans.input_tokens` (chat spans), else 0. */
  inputTokens: number;
  /** `spans.output_tokens` (chat spans), else 0. */
  outputTokens: number;
  /** `spans.cached_tokens` (chat spans), else 0. */
  cachedTokens: number;
  /** Sanitized repository resolved per session, else `unknown`. */
  repository: string;
}

/** Per-session rollup. Maps to cloud `AgentSessionSummary`. */
export interface SessionSummary {
  sessionId: string;
  /** Sanitized repository resolved per session, else `unknown`. */
  repository: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  /** Total spans in the session (`sessions.span_count`). */
  interactionCount: number;
  /** `chat` spans (`sessions.llm_calls`). */
  llmCalls: number;
  /** `execute_tool` spans (`sessions.tool_calls`). */
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Responding model (`sessions.model`), else `unknown`. */
  model: string;
  /** Distinct mapped agent modes seen in the session. */
  agentModes: AgentMode[];
}

/**
 * One row of a session's chronological timeline for the LOCAL detail view.
 *
 * Unlike {@link Interaction} (safe metadata only), this entry MAY carry the
 * raw {@link SessionTimelineEntry.userRequest}. That field is read exclusively
 * for local webview display, is never logged, and never crosses any networked
 * path. It is HTML-escaped before rendering.
 */
export interface SessionTimelineEntry {
  /** `spans.start_time_ms` (epoch ms). */
  timestampMs: number;
  /** `spans.operation_name`. */
  operation: Operation | string;
  /** Resolved agent mode (mapped to the known set). */
  agentMode: AgentMode;
  /** Resolved model id (response_model, else request_model), else `unknown`. */
  model: string;
  /** `spans.tool_name` (execute_tool spans), else `undefined`. */
  toolName?: string;
  /** `end_time_ms - start_time_ms`. */
  durationMs: number;
  /** `true` when `status_code` ∈ {0 unset, 1 ok}; `false` only for 2 (error). */
  success: boolean;
  /**
   * LOCAL-ONLY raw `copilot_chat.user_request` for `chat` spans, when present.
   * Privacy-critical: display in the local webview only — never log or upload.
   */
  userRequest?: string;
}

/**
 * Per-model token rollup within a single session, used by the LOCAL detail panel
 * to show a "cost & tokens by model" breakdown.
 *
 * Accumulated over the session's LLM-operation spans (`chat` and `invoke_agent`)
 * — the only operations that carry a model and token counts; tool/hook spans are
 * excluded so a session never grows a spurious all-zero `unknown` bucket. The
 * {@link model} is the RAW resolved id (response_model, else request_model, else
 * `unknown`); divergent forms of the same model (e.g. the dotted request id vs
 * the dashed response id) intentionally remain separate rows here and are only
 * unified for pricing via {@link ../telemetry/pricing.normalizeModelId}.
 */
export interface SessionModelUsage {
  /** Resolved model id (response_model, else request_model, else `unknown`). */
  model: string;
  /** LLM spans (`chat` + `invoke_agent`) attributed to this model. */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** `spans.reasoning_tokens` when the optional column is present, else 0. */
  reasoningTokens: number;
}

/**
 * A single session's full drill-down for the LOCAL detail panel: the safe
 * {@link SessionSummary} header plus the chronological {@link SessionTimelineEntry}
 * timeline (which may include local-only raw content) and a per-model usage
 * rollup ({@link SessionModelUsage}) for the cost/tokens breakdown.
 */
export interface SessionDetail {
  summary: SessionSummary;
  timeline: SessionTimelineEntry[];
  /** Per-model token rollup (LLM ops only), sorted by total tokens desc. */
  modelUsage: SessionModelUsage[];
}

/** Per-repository rollup used for the two-level Sessions tree. */
export interface RepositorySummary {
  /** Sanitized repository, else `unknown`. */
  repository: string;
  sessionCount: number;
  interactionCount: number;
  /** Distinct resolved models active in the repository. */
  models: string[];
  /** Latest span start time across the repository (epoch ms). */
  lastActivityMs: number;
}

/** Top-level overview metrics for the Overview tree. */
export interface OverviewMetrics {
  totalInteractions: number;
  totalSessions: number;
  totalRepositories: number;
  totalModels: number;
  /** Average span duration in ms (0 when no interactions). */
  avgDurationMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Count of spans with `status_code = 2`. */
  errorCount: number;
}

/**
 * OTEL status code → success boolean.
 *
 * `success = status_code in {0 unset, 1 ok}`; only `2` (error) is a failure.
 * Unset (0) is deliberately treated as a non-error (see schema doc §9.1).
 */
export function statusToSuccess(code: number | null | undefined): boolean {
  return code !== 2;
}

/** The agent modes recognized as non-custom (kept verbatim downstream). */
const KNOWN_AGENT_MODES: ReadonlySet<string> = new Set<AgentMode>([
  'default',
  'ask',
  'edit',
  'agent',
]);

/**
 * Map a raw `copilot_chat.mode_name` to the known set.
 *
 * - Absent / blank → `default`.
 * - A known mode (case-insensitive) → that mode.
 * - Anything else (user-defined custom mode) → `custom`, so a custom mode name
 *   that could embed project/customer identifiers never leaves verbatim. This
 *   mirrors the aggregate schema's `agentMode` privacy rule and is shared with
 *   Phase 5.
 */
export function mapAgentMode(raw: string | null | undefined): AgentMode {
  if (raw === null || raw === undefined) {
    return 'default';
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized.length === 0) {
    return 'default';
  }
  if (KNOWN_AGENT_MODES.has(normalized)) {
    return normalized as AgentMode;
  }
  return 'custom';
}
