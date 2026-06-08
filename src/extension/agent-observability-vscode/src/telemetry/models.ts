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
 * One user-request "turn" for the LOCAL detail view: a top-level user request,
 * the chronological tool/hook/sub-agent events it triggered, and the assistant's
 * final response.
 *
 * A turn is anchored by a MAIN-THREAD LLM span carrying a
 * `copilot_chat.user_request` — a `chat` span (ask mode) or an `invoke_agent`
 * span whose conversation_id equals its chat_session_id (agent mode). Spawned
 * sub-agents (invoke_agent with a distinct chat_session_id) never start a turn;
 * they appear as {@link SessionTurn.events}.
 *
 * Privacy-critical: {@link userRequest} and {@link finalResponse} carry raw
 * local-only content (`copilot_chat.user_request` / `gen_ai.output.messages`).
 * They are read exclusively for the local webview, HTML-escaped before display,
 * and never logged or uploaded.
 */
export interface SessionTurn {
  /** `spans.start_time_ms` of the anchoring span (epoch ms). */
  timestampMs: number;
  /** Resolved agent mode (mapped to the known set). */
  agentMode: AgentMode;
  /** Resolved model id of the anchor span (response_model, else request_model). */
  model: string;
  /** Anchor span duration; for agent-mode turns this spans the whole turn. */
  durationMs: number;
  /** `true` when the anchor's `status_code` ∈ {0 unset, 1 ok}. */
  success: boolean;
  /**
   * LOCAL-ONLY raw `copilot_chat.user_request` for this turn, when present.
   * Absent on the synthetic leading turn that holds spans preceding the first
   * anchor (or tool-only sessions with no anchor at all).
   */
  userRequest?: string;
  /**
   * LOCAL-ONLY assistant final-response text, extracted from the anchor span's
   * `gen_ai.output.messages` attribute (see {@link ./responseText.extractResponseText}).
   */
  finalResponse?: string;
  /**
   * Token usage for this turn, summed over its MAIN-THREAD LLM spans (the anchor
   * plus any main-thread `chat`/`invoke_agent` events) — the same spans that feed
   * the session totals, so summing every turn reproduces the
   * {@link SessionSummary} token counts. Spawned sub-agent events are excluded
   * (their tokens belong to the sub-agent's own session).
   */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** `spans.reasoning_tokens` when the optional column is present, else 0. */
  reasoningTokens: number;
  /** Tool/hook/sub-agent events that ran during this turn, in chronological order. */
  events: SessionTimelineEntry[];
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
  /** LLM spans (`chat` + main-thread `invoke_agent`) attributed to this model. */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** `spans.reasoning_tokens` when the optional column is present, else 0. */
  reasoningTokens: number;
}

/**
 * Per-(agent, model) token rollup within a single session, distinguished by
 * {@link SessionAgentUsage.kind}. This is the richer companion to
 * {@link SessionModelUsage}: it preserves WHICH agent spent the tokens (e.g. the
 * main `GitHub Copilot Chat` thread vs a spawned `Testing` / `Frontend`
 * sub-agent), which the per-model rollup collapses away.
 *
 * `kind`:
 * - `main` — the main conversation thread (`chat` spans and main-thread
 *   `invoke_agent` spans whose chat_session_id equals the conversation). These
 *   sum to the {@link SessionSummary} token totals.
 * - `subagent` — a sub-agent the main agent spawned via a `runSubagent` tool
 *   call (an `invoke_agent` span whose chat_session_id is the spawning tool-call
 *   id, distinct from the conversation). Its tokens are ALSO attributed to the
 *   sub-agent's own session, so they are shown for visibility but EXCLUDED from
 *   the session totals to avoid double-counting (see
 *   `invoke-agent-token-double-count`).
 */
export interface SessionAgentUsage {
  /** `spans.agent_name`, defaulting to `copilot` when absent. */
  agentName: string;
  /** Resolved model id (response_model, else request_model, else `unknown`). */
  model: string;
  /** Whether this is the main conversation thread or a spawned sub-agent. */
  kind: 'main' | 'subagent';
  /** LLM spans attributed to this (agent, model, kind). */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** `spans.reasoning_tokens` when the optional column is present, else 0. */
  reasoningTokens: number;
}

/**
 * Stable composite key for a {@link SessionAgentUsage} row, used to correlate a
 * rollup row with its computed cost estimate across the pure renderer / panel
 * boundary. The NUL separator can never appear in an agent name or model id, so
 * the three fields round-trip unambiguously.
 */
export function agentUsageKey(u: {
  agentName: string;
  model: string;
  kind: 'main' | 'subagent';
}): string {
  return `${u.agentName} ${u.model} ${u.kind}`;
}

/**
 * A single session's full drill-down for the LOCAL detail panel: the safe
 * {@link SessionSummary} header plus the per-user-request {@link SessionTurn}
 * grouping (which may include local-only raw content) and a per-model usage
 * rollup ({@link SessionModelUsage}) for the cost/tokens breakdown.
 */
export interface SessionDetail {
  summary: SessionSummary;
  /**
   * The session's interactions grouped into user-request turns, in chronological
   * order. Every span is accounted for: anchored turns hold their triggered
   * events, and a leading synthetic turn (no {@link SessionTurn.userRequest})
   * holds any spans preceding the first anchor.
   */
  turns: SessionTurn[];
  /**
   * Per-model token rollup for the MAIN thread (chat + main-thread invoke_agent),
   * sorted by total tokens desc. Sums to the {@link SessionSummary} token totals.
   */
  modelUsage: SessionModelUsage[];
  /**
   * Per-(agent, model) token rollup over ALL LLM spans — main thread and spawned
   * sub-agents — sorted main-first then by total tokens desc. Lets the detail view
   * attribute usage to each agent; sub-agent rows are excluded from the totals.
   */
  agentUsage: SessionAgentUsage[];
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
