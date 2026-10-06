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
 * Which agent tool produced a session. `copilot` reads the local SQLite
 * `agent-traces.db`; `claude` reads Claude Code's JSONL transcripts under
 * `~/.claude/projects`; `copilot-cloud` reads GitHub Copilot **cloud
 * coding-agent** task/session logs pulled down into a local sink
 * (`~/.agent-observability/copilot-cloud/`); `copilot-agent` reads **autonomous
 * Copilot CLI agent** runs (e.g. an ACA job remediating an alert) that push their
 * full `gen_ai.*` OTLP to a cloud landing spot, pulled down into a local sink
 * (`~/.agent-observability/copilot-agent/`). Defaults to `copilot` when absent
 * (the Copilot producer predates this field). Used to group the Sessions tree by
 * source and to switch the detail panel's cost basis (Copilot and the autonomous
 * Copilot agent both bill in AIU — they emit the same OTel schema; Claude is
 * priced by tokens — see {@link SessionTreeStats.costUsdMicros}; the cloud agent
 * bills in AI credits — see {@link SessionTreeStats.creditsNano}).
 */
export type AgentSourceId =
  | 'copilot'
  | 'claude'
  | 'copilot-cloud'
  | 'copilot-agent'
  | 'copilot-cli'
  | 'copilot-app'
  | 'copilot-jetbrains';

/**
 * Cost basis a source is priced in, used by the detail panel to render the right
 * cost tile/column. Promoted from a per-source `id` ternary to the
 * `SessionDataSource` contract so a new source declares its basis directly:
 * - `aiu` — GitHub Copilot premium-request units (with a derived $ at $0.01/AIU);
 * - `usd` — a token×rate USD estimate (Claude Code), carried in `costUsdMicros`;
 * - `credits` — GitHub cloud coding-agent AI credits, carried in `creditsNano`.
 *   Credits are shown as their own unit and are NEVER converted to the AIU $ rate.
 */
export type CostMode = 'aiu' | 'usd' | 'credits';

/**
 * Which billed unit a Copilot (Cloud) session's `creditsNano` is denominated in.
 * GitHub's agent-tasks API reports `usage.type` per session and — mid-migration —
 * mixes two units even under one owner:
 * - `ai_credits` — legacy "AI credits"; the raw value is already in nano-credits
 *   (e.g. `10191735000` ⇒ `10.19` credits), shown with decimals.
 * - `pru` — the current "premium request" unit; the raw value is a (small, often
 *   whole) request count normalized to nano here so `creditsNano` keeps its
 *   `1 unit = 1e9` contract, shown as a plain count.
 * Absent for local sources. Drives the detail panel's credit tile/column LABEL and
 * number precision so the two units never render under the same name or scale.
 */
export type CloudCreditUnit = 'ai_credits' | 'pru';

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
  /**
   * LOCAL-ONLY estimated main-thread cost in INTEGER micro-USD (1 USD = 1e6).
   * Set by the Claude Code source (token×rate over the same per-turn usage the
   * detail view prices — see `../claude/pricing.ts`), so a list row and the
   * detail's Main agent row agree by construction. ABSENT means the session had
   * LLM calls but none could be priced (unknown model) — "unpriced", which is
   * not the same statement as a true `0`. Never on the aggregate/sync path.
   */
  costMicros?: number;
  /** Responding model (`sessions.model`), else `unknown`. */
  model: string;
  /** Distinct mapped agent modes seen in the session. */
  agentModes: AgentMode[];
  /**
   * LOCAL-ONLY human-readable session name from Copilot's chat-session store
   * (see {@link ../telemetry/sessionTitles}), when available. Either Copilot's
   * auto-generated title / a user rename ({@link titleDerived} `false`) or the
   * first request's text ({@link titleDerived} `true`).
   *
   * Privacy-critical: model-/user-derived raw content for the local Sessions
   * view ONLY — never logged and never placed on the aggregate/sync path.
   */
  title?: string;
  /** `true` when {@link title} was derived from the first request's text. */
  titleDerived?: boolean;
  /**
   * LOCAL-ONLY: the name this session had BEFORE the user renamed it, present
   * only when they did. Lets the detail view say the title on screen is the
   * user's own — a session marked as renamed in the list would otherwise open on
   * a header that gives no sign of it, and no way back to the original name.
   *
   * Same privacy class as {@link title}: local display only, never on the
   * aggregate/sync path.
   */
  titleOriginal?: string;
  /**
   * Which agent tool produced this session ({@link AgentSourceId}). Absent for
   * Copilot sessions (treated as `copilot`); set to `claude` by the Claude Code
   * source so the unified Sessions tree can group by source.
   */
  source?: AgentSourceId;
  /**
   * Optional short lifecycle badge for sources whose sessions are not always
   * terminal (e.g. the Copilot cloud agent: `queued` / `in progress` /
   * `waiting for user` / `failed` / `timed out`). Rendered on the session row
   * only when present; local-only, never uploaded.
   */
  stateLabel?: string;
  /**
   * Optional external URL for an "Open on GitHub" header link (e.g. the cloud
   * agent's agents-hub or PR/session page). Absent for local sources. Opened via
   * `vscode.env.openExternal` from the detail panel (the webview CSP blocks a
   * bare `href`).
   */
  externalUrl?: string;
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
  /**
   * LOCAL-ONLY lines this turn's MAIN-THREAD file-writing tool calls added to /
   * removed from source-code vs documentation files, classified by file
   * extension (see {@link ./locAnalysis.countWrittenLines}). Derived from the
   * raw `gen_ai.tool.call.arguments` attribute, which never leaves the machine;
   * only these integer counts are retained. All `0` when extension lists are
   * unset or the turn wrote nothing classifiable.
   */
  linesOfCode: number;
  linesOfDoc: number;
  linesOfCodeRemoved: number;
  linesOfDocRemoved: number;
  /** Tool/hook/sub-agent events that ran during this turn, in chronological order. */
  events: SessionTimelineEntry[];
}

/**
 * One model turn (a single `chat` span) of the WHOLE agent tree — the finest unit
 * the local token trend plots. Unlike the main-thread {@link SessionTurn} grouping
 * (which only sees the root conversation's spans), these are taken over the entire
 * `conversation_id`/`chat_session_id` component, so they include the nested chat
 * turns that agent mode records under child conversation ids (and any spawned
 * sub-agents). The series therefore reconciles with {@link SessionTreeStats}: the
 * point count equals {@link SessionTreeStats.modelTurns} and the per-field sums
 * equal the card's token / line totals.
 *
 * Holds the span's own token counts plus the source/doc lines its requested file
 * writes added/removed (attributed to the model turn that requested them; see the
 * attribution in {@link ../telemetry/database}). Carries no raw content, only
 * integer counts and a timestamp, so it is safe for the local webview.
 */
export interface SessionModelTurnPoint {
  /** `spans.start_time_ms` of the `chat` span (epoch ms), used to order the series. */
  timestampMs: number;
  /** Resolved model id (response_model, else request_model, else `unknown`). */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** `spans.reasoning_tokens` when the optional column is present, else 0. */
  reasoningTokens: number;
  /**
   * Lines this model turn's requested file-writing tool calls added to / removed
   * from source-code vs documentation files (LoC / LoD / nLoC / nLoD). All `0`
   * when extension lists are unset or it wrote nothing classifiable.
   */
  linesOfCode: number;
  linesOfDoc: number;
  linesOfCodeRemoved: number;
  linesOfDocRemoved: number;
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
  /** `chat` model turns across the agent tree attributed to this model. */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** `spans.reasoning_tokens` when the optional column is present, else 0. */
  reasoningTokens: number;
  /**
   * GitHub's authoritative premium-request usage in NANO-AIU (1 AIU = 1e9), summed
   * from the `copilot_chat.copilot_usage_nano_aiu` attribute over this model's
   * `chat` spans across the WHOLE agent tree. Unlike the token×rate estimate this
   * is the unit GitHub actually bills, so it is the primary cost figure. Stored as
   * an integer nano count so sums stay exact; divide by 1e9 for AIU at the display
   * boundary. `0` only when no billable AIU was recorded (e.g. free/included
   * utility calls). Because this is tree-scoped, a spawned sub-agent's AIU is now
   * captured here (it is not lost to the sub-agent's own session as before).
   */
  aiuNano: number;
  /**
   * LOCAL-ONLY estimated USD cost for this model, in INTEGER micro-USD (1 USD =
   * 1e6). Set ONLY by the Claude Code source (token×rate — see
   * `../claude/pricing.ts`), where AIU does not apply; absent for Copilot, whose
   * cost derives from {@link aiuNano}. The detail panel shows a "Cost" column
   * instead of "AIU" when this is present.
   */
  costUsdMicros?: number;
  /**
   * GitHub cloud coding-agent AI-credit usage in INTEGER NANO-CREDITS (1 credit =
   * 1e9), summed for this model. Set ONLY by the Copilot (Cloud) source; absent
   * for the local sources (which use {@link aiuNano} / {@link costUsdMicros}).
   * Kept as its own unit — never mapped onto {@link aiuNano} (whose $0.01/AIU
   * derivation would be a lie for credits).
   */
  creditsNano?: number;
}

/**
 * Per-(agent, model) token rollup over the whole agent tree, distinguished by
 * {@link SessionAgentUsage.kind}. This is the richer companion to
 * {@link SessionModelUsage}: it preserves WHICH agent spent the tokens (the
 * `Main agent` thread vs each spawned `Sub-agent: <Name>`), which the per-model
 * rollup collapses away. Both are aggregated over the tree's `chat` spans, so they
 * reconcile with {@link SessionTreeStats}.
 *
 * `kind` is classified from each `chat` turn's `copilot_chat.debug_log_label`
 * (`runSubagent-*`) / `agent_name` (`tool/runSubagent*`) — a signal independent of
 * which tree node was opened:
 * - `main` — the main conversation thread.
 * - `subagent` — a sub-agent the main agent spawned via a `runSubagent` tool call.
 *
 * Unlike the main-thread {@link SessionSummary}, these rows include the spawned
 * sub-agents' real tokens AND AIU (recorded on the sub-agents' own `chat` spans).
 */
export interface SessionAgentUsage {
  /** Friendly agent label: `Main agent`, or `Sub-agent[: <Name>]` for a spawn. */
  agentName: string;
  /** Resolved model id (response_model, else request_model, else `unknown`). */
  model: string;
  /** Whether this is the main conversation thread or a spawned sub-agent. */
  kind: 'main' | 'subagent';
  /** `chat` model turns attributed to this (agent, model, kind). */
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** `spans.reasoning_tokens` when the optional column is present, else 0. */
  reasoningTokens: number;
  /**
   * Premium-request usage in NANO-AIU (1 AIU = 1e9) for this (agent, model, kind),
   * summed from `copilot_chat.copilot_usage_nano_aiu` over the tree's `chat` spans.
   * See {@link SessionModelUsage.aiuNano}. Because the breakdown is tree-scoped, a
   * spawned sub-agent's rows now carry their real AIU (their `chat` spans live
   * under their own conversation id), rather than reading `0` as before.
   */
  aiuNano: number;
  /**
   * LOCAL-ONLY estimated USD cost for this (agent, model, kind), in INTEGER
   * micro-USD. Set ONLY by the Claude Code source; absent for Copilot (which uses
   * {@link aiuNano}). See {@link SessionModelUsage.costUsdMicros}.
   */
  costUsdMicros?: number;
  /**
   * GitHub cloud coding-agent AI-credit usage in INTEGER NANO-CREDITS (1 credit =
   * 1e9) for this (agent, model, kind). Set ONLY by the Copilot (Cloud) source.
   * See {@link SessionModelUsage.creditsNano}.
   */
  creditsNano?: number;
  /**
   * The unit {@link creditsNano} is denominated in ({@link CloudCreditUnit}). Set
   * ONLY by the Copilot (Cloud) source; absent for local sources. See
   * {@link SessionTreeStats.creditUnit}.
   */
  creditUnit?: CloudCreditUnit;
  /**
   * LOCAL-ONLY lines this (agent, model, kind)'s file-writing tool calls added to /
   * removed from source-code vs documentation files (LoC / LoD / nLoC / nLoD). Each
   * tree file-write is attributed to the `chat` model turn that requested it (by
   * timestamp — see {@link ../telemetry/database}), and that turn's (agent, model,
   * kind) owns the lines; summing the rows therefore reproduces the
   * {@link SessionTreeStats} line totals. All `0` when extension lists are unset or
   * nothing classifiable was written.
   */
  linesOfCode: number;
  linesOfDoc: number;
  linesOfCodeRemoved: number;
  linesOfDocRemoved: number;
  /**
   * Wall-clock run time of this (agent, model, kind) in ms — last observed
   * activity minus first observed activity of its model turns within ONE session
   * (Copilot: chat-span start/end times; Claude: assistant-record and
   * tool-execution timestamps; Cloud: the session's own run time). Trailing tool
   * executions after the last model turn are not tracked for Copilot. In MERGED
   * views (combined sessions / repository) the per-session values are SUMMED —
   * never min/max across sessions, which would count idle time between sessions.
   * `undefined` when the source has no usable timestamps; rendered as an em dash.
   */
  runDurationMs?: number;
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
 * Whole-agent-tree totals matching GitHub's per-session **Agent Debug Logs**
 * summary card. Unlike {@link SessionSummary} (main thread only — `chat` +
 * main-thread `invoke_agent`, sub-agents EXCLUDED to avoid the cross-session
 * double-count), this INCLUDES every spawned sub-agent, so it reads larger and
 * equals what GitHub shows for the session.
 *
 * The "agent tree" is the connected component over `conversation_id` /
 * `chat_session_id` edges rooted at the opened session (it reaches sub-agents via
 * their `call_…`/`toolu_…` spawn ids and their own conversation ids). All counts
 * and token sums are taken over that component's `chat` spans (each model turn is
 * counted once; `invoke_agent` spans are just per-agent rollups of the same chat
 * turns, so summing them would double-count). See the verified metric definitions
 * in the plan / the `agent-debug-log-session-stats` memory.
 */
export interface SessionTreeStats {
  /** `chat` span count across the tree → GitHub's "Model Turns". */
  modelTurns: number;
  /** `execute_tool` span count across the tree → GitHub's "Tool Calls". */
  toolCalls: number;
  /**
   * Fresh (non-cache-read) input tokens over the tree's `chat` spans → "Total Input
   * Tokens". DISJOINT from {@link cachedTokens}: Claude = uncached `input_tokens` +
   * `cache_creation`; Copilot = gross `input_tokens` − cache reads.
   */
  inputTokens: number;
  /** Σ `output_tokens` over the tree's `chat` spans. */
  outputTokens: number;
  /**
   * Cache-READ input tokens over the tree's `chat` spans → "Total Cached Input
   * Tokens". The cheap reused-prompt bucket, disjoint from {@link inputTokens}.
   */
  cachedTokens: number;
  /**
   * {@link inputTokens} + {@link cachedTokens} + {@link outputTokens} → "Total
   * Tokens". The three buckets are disjoint, so this is the genuine total.
   */
  totalTokens: number;
  /** Count of spans with `status_code === 2` across the tree → "Errors". */
  errorCount: number;
  /**
   * Σ `copilot_chat.copilot_usage_nano_aiu` over the tree's `chat` spans, in
   * integer NANO-AIU (1 AIU = 1e9). Divide by 1e9 for GitHub's "Copilot Usage
   * (AIU)". Includes sub-agents' AIU (where the real billing lives); the per-model
   * and per-agent breakdowns ({@link SessionModelUsage}/{@link SessionAgentUsage})
   * are taken over the same tree `chat` spans and so sum to this value.
   */
  aiuNano: number;
  /**
   * LOCAL-ONLY estimated whole-tree USD cost in INTEGER micro-USD (1 USD = 1e6).
   * Set ONLY by the Claude Code source (token×rate; AIU is `0` there); absent for
   * Copilot, whose cost is derived from {@link aiuNano}. The "Agent run totals"
   * card shows a "Cost (USD)" tile in place of "AIU" when this is present. Equals
   * the sum of the per-model / per-agent `costUsdMicros` rollups.
   */
  costUsdMicros?: number;
  /**
   * Whole-tree GitHub cloud coding-agent AI-credit usage in INTEGER NANO-CREDITS
   * (1 credit = 1e9). Set ONLY by the Copilot (Cloud) source (from the REST
   * session's `usage.credits`); absent for the local sources. The "Agent run
   * totals" card shows an "AI Credits" tile in place of "AIU"/"Cost" when the
   * source's cost basis is `credits`. Equals the sum of the per-model / per-agent
   * `creditsNano` rollups.
   */
  creditsNano?: number;
  /**
   * The unit {@link creditsNano} is denominated in ({@link CloudCreditUnit}). Set
   * ONLY by the Copilot (Cloud) source alongside {@link creditsNano}; absent for
   * local sources. Drives the credit tile's LABEL ("Premium Requests" vs "AI
   * Credits") and number precision so the two mixed units render honestly.
   */
  creditUnit?: CloudCreditUnit;
  /**
   * LOCAL-ONLY lines the whole agent tree's file-writing tool calls added to /
   * removed from source-code vs documentation files, classified by file
   * extension (see {@link ./locAnalysis.sumWrittenLines}). `linesOfCode` /
   * `linesOfDoc` are additions (LoC / LoD); `linesOfCodeRemoved` /
   * `linesOfDocRemoved` are removals (nLoC / nLoD). Derived from the raw
   * `gen_ai.tool.call.arguments` attribute — which never leaves the machine —
   * with only these integer counts retained. All `0` when the extension lists
   * are unset (the cloud-safe call sites pass none).
   */
  linesOfCode: number;
  linesOfDoc: number;
  linesOfCodeRemoved: number;
  linesOfDocRemoved: number;
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
   * Whole-agent-tree totals (incl. spawned sub-agents) matching GitHub's Agent
   * Debug Logs card. Rendered as a dedicated summary card in the detail view,
   * distinct from the main-thread {@link summary} totals.
   */
  treeStats: SessionTreeStats;
  /**
   * The session's interactions grouped into user-request turns, in chronological
   * order. Every span is accounted for: anchored turns hold their triggered
   * events, and a leading synthetic turn (no {@link SessionTurn.userRequest})
   * holds any spans preceding the first anchor.
   */
  turns: SessionTurn[];
  /**
   * Per-model token rollup over the WHOLE agent tree's `chat` spans (incl. spawned
   * sub-agents), sorted by total tokens desc. Sums to the {@link treeStats} token
   * totals — NOT to the main-thread {@link summary}.
   */
  modelUsage: SessionModelUsage[];
  /**
   * Per-(agent, model) token rollup over the WHOLE agent tree's `chat` spans —
   * the main thread and every spawned sub-agent — sorted main-first then by total
   * tokens desc. Lets the detail view attribute real tokens AND AIU to each agent;
   * sums to {@link treeStats}.
   */
  agentUsage: SessionAgentUsage[];
  /**
   * Every model turn of the WHOLE agent tree as an ordered series of points, for
   * the detail panel's token trend. Taken over the same tree `chat` spans as
   * {@link treeStats} (NOT the narrower main-thread {@link turns} grouping, which
   * misses the chat turns agent mode records under child conversation ids), so the
   * trend reconciles with the "Agent run totals" card it sits in: one point per
   * {@link SessionTreeStats.modelTurns}, summing to the card's token / line totals.
   */
  treeModelTurns: SessionModelTurnPoint[];
}

/**
 * Aggregate header for a COMBINED view over several selected sessions
 * ({@link CombinedSessionDetail}). Sums the per-session {@link SessionSummary}
 * counters and records the distinct repositories / models / modes that appear.
 * Like everything in this view it is built locally and never leaves the machine.
 */
export interface CombinedSummary {
  /** Number of distinct sessions combined. */
  sessionCount: number;
  /** Distinct sanitized repositories across the sessions, sorted. */
  repositories: string[];
  /** Distinct responding models across the sessions, sorted. */
  models: string[];
  /** Union of mapped agent modes across the sessions. */
  agentModes: AgentMode[];
  /** Earliest session start (epoch ms). */
  startedAtMs: number;
  /** Latest session end (epoch ms). */
  endedAtMs: number;
  /** Sum of each session's duration (overlapping wall-clock is not deducted). */
  totalDurationMs: number;
  /** Wall-clock span from the earliest start to the latest end. */
  spanMs: number;
  interactionCount: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/**
 * A COMBINED drill-down over several selected sessions for the LOCAL detail
 * panel. Holds the aggregate {@link CombinedSummary} plus per-model and
 * per-(agent, model) usage rollups MERGED across every combined session — the
 * same shapes the single-session view uses, so the cost helpers and renderer
 * sections are reused verbatim. The individual {@link SessionDetail}s (with
 * their local-only turns) are rendered as per-session sections by the panel and
 * are not duplicated here.
 */
export interface CombinedSessionDetail {
  summary: CombinedSummary;
  /**
   * Whole-agent-tree totals (incl. spawned sub-agents) summed across every
   * combined session — the merged counterpart of {@link SessionDetail.treeStats}.
   * Rendered as the combined "Agent run totals" card, mirroring the single-session
   * view. Because each session's {@link SessionTreeStats} is already tree-scoped
   * and rooted at a distinct opened session, summing them never double-counts.
   */
  treeStats: SessionTreeStats;
  /** Per-model token rollup merged across all combined sessions, sorted by total tokens desc. */
  modelUsage: SessionModelUsage[];
  /** Per-(agent, model) rollup merged across all sessions, sorted main-first then total tokens desc. */
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
