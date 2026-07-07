/**
 * Pure mapper: raw Copilot cloud task/session payloads (+ optional parsed CAPI
 * log) → the shared model shapes the unified views consume. Mirrors
 * `../claude/mapper.ts` so `cloudMapper.test.ts` parallels `mapper.test.ts`.
 *
 * No `vscode`, no IO — every input arrives on {@link CloudSessionInput}.
 *
 * Cost basis: the cloud agent bills in **AI credits** (`usage.credits`), mapped to
 * {@link SessionTreeStats.creditsNano} / the per-model / per-agent `creditsNano`.
 * `aiuNano` is `0` and `costUsdMicros` absent (credits are their own unit — never
 * the AIU $ rate). Tokens are populated only when the CAPI log carried `usage`
 * chunks (opportunistic); otherwise they are `0` (see the source's
 * "token counts unavailable" note).
 */

import {
  Interaction,
  SessionAgentUsage,
  SessionDetail,
  SessionModelUsage,
  SessionSummary,
  SessionTimelineEntry,
  SessionTreeStats,
  SessionTurn,
  statusToSuccess,
} from '../telemetry/models';
import {
  CloudSessionInput,
  ParsedCloudLog,
  cloudStateLabel,
  isTerminalCloudState,
  rfc3339ToMs,
  stripCloudModelPrefix,
} from './cloudTypes';

/** Friendly agent label for the single main-thread cloud agent row. */
export const CLOUD_AGENT_LABEL = 'Copilot cloud agent';

/** The effective session state (session-level wins over task-level). */
function effectiveState(input: CloudSessionInput): string {
  return (input.session.state ?? input.taskState) as string;
}

/** Resolve start/end/duration, marking non-terminal sessions as still running. */
function timing(input: CloudSessionInput): { startedAtMs: number; endedAtMs: number; durationMs: number } {
  const s = input.session;
  const startedAtMs = rfc3339ToMs(s.created_at) ?? 0;
  const terminal = isTerminalCloudState(effectiveState(input));
  const endedAtMs = terminal
    ? rfc3339ToMs(s.completed_at) ?? rfc3339ToMs(s.updated_at) ?? startedAtMs
    : // Non-terminal: still running — end at the latest known activity.
      Math.max(rfc3339ToMs(s.updated_at) ?? startedAtMs, startedAtMs);
  return { startedAtMs, endedAtMs, durationMs: Math.max(0, endedAtMs - startedAtMs) };
}

/** Distinct non-setup tool invocations (the real tool-call count). */
function toolCallCount(log: ParsedCloudLog | undefined): number {
  if (log === undefined) {
    return 0;
  }
  return log.toolInvocations.filter((t) => !t.isSetup).length;
}

/** Whole-tree AI-credit usage in nano-credits (raw `usage.credits`), or 0. */
function creditsNanoOf(input: CloudSessionInput): number {
  const credits = input.session.usage?.credits;
  return typeof credits === 'number' && Number.isFinite(credits) && credits > 0 ? Math.round(credits) : 0;
}

/** The session's title: session name (when distinct), else the task name, plus any suffix. */
function sessionTitle(input: CloudSessionInput): string {
  const name = input.session.name?.trim();
  const base = name !== undefined && name.length > 0 && name !== input.taskName ? name : input.taskName;
  return `${base}${input.sessionLabelSuffix ?? ''}`.trim();
}

/** Per-session rollup for the Sessions list / Overview aggregation. */
export function buildCloudSessionSummary(input: CloudSessionInput): SessionSummary {
  const { startedAtMs, endedAtMs, durationMs } = timing(input);
  const log = input.log;
  const usage = log?.tokenUsage;
  const llmCalls = log?.llmTurns ?? 0;
  const toolCalls = toolCallCount(log);
  const title = sessionTitle(input);
  return {
    sessionId: input.session.id,
    repository: input.repository,
    startedAtMs,
    endedAtMs,
    durationMs,
    interactionCount: llmCalls + toolCalls,
    llmCalls,
    toolCalls,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedTokens: usage?.cachedTokens ?? 0,
    model: stripCloudModelPrefix(input.session.model),
    agentModes: ['agent'],
    title: title.length > 0 ? title : undefined,
    titleDerived: false,
    source: 'copilot-cloud',
    stateLabel: cloudStateLabel(effectiveState(input)),
    externalUrl: input.externalUrl,
  };
}

/** Whole-tree totals card. Credits are the cost basis; AIU/USD stay unset. */
function buildCloudTreeStats(input: CloudSessionInput): SessionTreeStats {
  const log = input.log;
  const usage = log?.tokenUsage;
  const inputTokens = usage?.inputTokens ?? 0;
  const cachedTokens = usage?.cachedTokens ?? 0;
  const outputTokens = usage?.outputTokens ?? 0;
  // A genuinely failed run counts as an error even when it carries no error
  // string (the state alone is authoritative); a user-cancelled run does not.
  const state = effectiveState(input);
  const failedState = state === 'failed' || state === 'timed_out';
  const hasError = failedState || (typeof input.session.error === 'string' && input.session.error.length > 0);
  return {
    modelTurns: log?.llmTurns ?? 0,
    toolCalls: toolCallCount(log),
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + cachedTokens + outputTokens,
    errorCount: hasError ? 1 : 0,
    aiuNano: 0,
    creditsNano: creditsNanoOf(input),
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
  };
}

/** The tool/setup events of a session as timeline entries, in chronological order. */
function buildTimeline(input: CloudSessionInput, model: string): SessionTimelineEntry[] {
  const log = input.log;
  if (log === undefined) {
    return [];
  }
  return log.toolInvocations.map((inv) => ({
    timestampMs: inv.startedAtMs,
    // Setup infra ops are tagged so their operation reads distinctly; real tools
    // are `execute_tool`. Both are shown; only real tools count in tool metrics.
    operation: inv.isSetup ? 'run_setup' : 'execute_tool',
    agentMode: 'agent',
    model,
    toolName: inv.name,
    durationMs: inv.durationMs,
    success: inv.success,
  }));
}

/** Build the single user-request turn (Phase 1: one turn holds the whole session). */
function buildCloudTurns(input: CloudSessionInput, stats: SessionTreeStats): SessionTurn[] {
  const { startedAtMs, durationMs } = timing(input);
  const model = stripCloudModelPrefix(input.session.model);
  const log = input.log;
  const userRequest = firstUserRequest(input);
  const events = buildTimeline(input, model);
  // A session with nothing to attribute — no prompt, no events, no final response,
  // and no token/model-turn activity — has no turn. When token usage IS present
  // (even without content), emit the turn so its token sum still reconciles with
  // treeStats / the per-model + per-agent rollups.
  if (
    userRequest === undefined &&
    events.length === 0 &&
    log?.finalResponse === undefined &&
    stats.modelTurns === 0 &&
    stats.totalTokens === 0
  ) {
    return [];
  }
  return [
    {
      timestampMs: startedAtMs,
      agentMode: 'agent',
      model,
      durationMs,
      success: statusToSuccess(stats.errorCount > 0 ? 2 : 1),
      userRequest,
      finalResponse: log?.finalResponse,
      llmCalls: stats.modelTurns,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cachedTokens: stats.cachedTokens,
      reasoningTokens: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
      events,
    },
  ];
}

/** The authoritative first user request: REST `prompt`, else the first real SSE user line. */
function firstUserRequest(input: CloudSessionInput): string | undefined {
  const prompt = input.session.prompt?.trim();
  if (prompt !== undefined && prompt.length > 0) {
    return prompt;
  }
  const first = input.log?.userRequests[0]?.trim();
  return first !== undefined && first.length > 0 ? first : undefined;
}

/** Per-model rollup — a single row for the cloud session's one model. */
function buildCloudModelUsage(input: CloudSessionInput, stats: SessionTreeStats): SessionModelUsage[] {
  if (stats.modelTurns === 0 && stats.totalTokens === 0 && stats.creditsNano === 0) {
    return [];
  }
  return [
    {
      model: stripCloudModelPrefix(input.session.model),
      llmCalls: stats.modelTurns,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cachedTokens: stats.cachedTokens,
      reasoningTokens: 0,
      aiuNano: 0,
      creditsNano: stats.creditsNano,
    },
  ];
}

/** Per-(agent, model) rollup — a single `main` row (sub-agent split is deferred). */
function buildCloudAgentUsage(input: CloudSessionInput, stats: SessionTreeStats): SessionAgentUsage[] {
  if (stats.modelTurns === 0 && stats.totalTokens === 0 && stats.creditsNano === 0) {
    return [];
  }
  return [
    {
      agentName: CLOUD_AGENT_LABEL,
      model: stripCloudModelPrefix(input.session.model),
      kind: 'main',
      llmCalls: stats.modelTurns,
      inputTokens: stats.inputTokens,
      outputTokens: stats.outputTokens,
      cachedTokens: stats.cachedTokens,
      reasoningTokens: 0,
      aiuNano: 0,
      creditsNano: stats.creditsNano,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    },
  ];
}

/** The full drill-down for the detail panel. */
export function buildCloudSessionDetail(input: CloudSessionInput): SessionDetail {
  const summary = buildCloudSessionSummary(input);
  const treeStats = buildCloudTreeStats(input);
  return {
    summary,
    treeStats,
    turns: buildCloudTurns(input, treeStats),
    modelUsage: buildCloudModelUsage(input, treeStats),
    agentUsage: buildCloudAgentUsage(input, treeStats),
    // No per-turn usage points (only summed usage), so the trend is disabled.
    treeModelTurns: [],
  };
}

/**
 * Metadata interactions for the deviation path / detail. One `chat` interaction
 * (the turn) plus one `execute_tool` per real tool invocation. Content-free.
 */
export function buildCloudInteractions(input: CloudSessionInput): Interaction[] {
  const { startedAtMs, durationMs } = timing(input);
  const model = stripCloudModelPrefix(input.session.model);
  const stats = buildCloudTreeStats(input);
  const traceId = input.session.id;
  const out: Interaction[] = [];
  out.push({
    timestampMs: startedAtMs,
    sessionId: input.session.id,
    traceId,
    spanId: input.session.id,
    operation: 'chat',
    agentName: 'copilot-cloud',
    agentMode: 'agent',
    model,
    durationMs,
    success: stats.errorCount === 0,
    inputTokens: stats.inputTokens,
    outputTokens: stats.outputTokens,
    cachedTokens: stats.cachedTokens,
    repository: input.repository,
  });
  for (const inv of input.log?.toolInvocations ?? []) {
    if (inv.isSetup) {
      continue;
    }
    out.push({
      timestampMs: inv.startedAtMs,
      sessionId: input.session.id,
      traceId,
      operation: 'execute_tool',
      agentName: 'copilot-cloud',
      agentMode: 'agent',
      model,
      toolName: inv.name,
      durationMs: inv.durationMs,
      success: inv.success,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      repository: input.repository,
    });
  }
  return out;
}

/**
 * LOCAL-ONLY content lookup for the deviation detector's content predicates. Only
 * `copilot_chat.user_request` is populated (the session prompt); other attributes
 * return an empty map (inert), matching the Claude source.
 */
export function buildCloudUserRequestContent(input: CloudSessionInput): Map<string, string> {
  const map = new Map<string, string>();
  const prompt = firstUserRequest(input);
  if (prompt !== undefined) {
    map.set(input.session.id, prompt);
  }
  return map;
}
