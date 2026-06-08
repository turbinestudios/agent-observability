import {
  CombinedSessionDetail,
  CombinedSummary,
  SessionAgentUsage,
  SessionDetail,
  SessionModelUsage,
  agentUsageKey,
} from './models';

/**
 * Combine several single-session {@link SessionDetail}s into one
 * {@link CombinedSessionDetail} for the LOCAL "combined sessions" view.
 *
 * Pure (no `vscode`, no I/O): the panel fetches each session's detail and hands
 * the array here; the result is rendered locally. The token rollups are MERGED
 * by the same keys the single-session view uses ({@link SessionModelUsage.model}
 * and {@link agentUsageKey}) so the existing cost helpers and renderer sections
 * apply unchanged. Sub-agent rows stay `kind: 'subagent'` and so remain excluded
 * from the combined header totals, exactly as in one session.
 *
 * Ordering matches the single-session renderer: `modelUsage` by total tokens
 * desc; `agentUsage` main-thread first, then by total tokens desc.
 *
 * @throws when `details` is empty — a combined view of nothing is meaningless;
 *   callers guard the selection before invoking.
 */
export function combineSessionDetails(details: readonly SessionDetail[]): CombinedSessionDetail {
  if (details.length === 0) {
    throw new Error('combineSessionDetails requires at least one session.');
  }

  return {
    summary: combineSummaries(details),
    modelUsage: mergeModelUsage(details),
    agentUsage: mergeAgentUsage(details),
  };
}

/** Aggregate the per-session summaries into the combined header. */
function combineSummaries(details: readonly SessionDetail[]): CombinedSummary {
  const summaries = details.map((d) => d.summary);
  const repositories = new Set<string>();
  const models = new Set<string>();
  const agentModes = new Set<string>();

  const acc: Omit<CombinedSummary, 'repositories' | 'models' | 'agentModes' | 'spanMs'> = {
    sessionCount: summaries.length,
    startedAtMs: summaries[0].startedAtMs,
    endedAtMs: summaries[0].endedAtMs,
    totalDurationMs: 0,
    interactionCount: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  };

  for (const s of summaries) {
    repositories.add(s.repository);
    models.add(s.model);
    for (const m of s.agentModes) {
      agentModes.add(m);
    }
    acc.startedAtMs = Math.min(acc.startedAtMs, s.startedAtMs);
    acc.endedAtMs = Math.max(acc.endedAtMs, s.endedAtMs);
    acc.totalDurationMs += s.durationMs;
    acc.interactionCount += s.interactionCount;
    acc.llmCalls += s.llmCalls;
    acc.toolCalls += s.toolCalls;
    acc.inputTokens += s.inputTokens;
    acc.outputTokens += s.outputTokens;
    acc.cachedTokens += s.cachedTokens;
  }

  return {
    ...acc,
    repositories: [...repositories].sort(),
    models: [...models].sort(),
    agentModes: [...agentModes].sort() as CombinedSummary['agentModes'],
    spanMs: acc.endedAtMs - acc.startedAtMs,
  };
}

/** Merge every session's per-model rollup by model id, summing token counts. */
function mergeModelUsage(details: readonly SessionDetail[]): SessionModelUsage[] {
  const byModel = new Map<string, SessionModelUsage>();
  for (const d of details) {
    for (const u of d.modelUsage) {
      const existing = byModel.get(u.model);
      if (existing === undefined) {
        byModel.set(u.model, { ...u });
      } else {
        addTokens(existing, u);
      }
    }
  }
  return [...byModel.values()].sort(byTotalTokensDesc);
}

/** Merge every session's per-(agent, model, kind) rollup, summing token counts. */
function mergeAgentUsage(details: readonly SessionDetail[]): SessionAgentUsage[] {
  const byAgent = new Map<string, SessionAgentUsage>();
  for (const d of details) {
    for (const u of d.agentUsage) {
      const key = agentUsageKey(u);
      const existing = byAgent.get(key);
      if (existing === undefined) {
        byAgent.set(key, { ...u });
      } else {
        addTokens(existing, u);
      }
    }
  }
  // Main thread first, then by total tokens desc — matches the single-session order.
  return [...byAgent.values()].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'main' ? -1 : 1;
    }
    return byTotalTokensDesc(a, b);
  });
}

/** Token shape shared by both rollups; accumulate `from` into `into` in place. */
interface TokenCounts {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

function addTokens(into: TokenCounts, from: TokenCounts): void {
  into.llmCalls += from.llmCalls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cachedTokens += from.cachedTokens;
  into.reasoningTokens += from.reasoningTokens;
}

/** Sort by input+output tokens descending (the renderer's stable ordering). */
function byTotalTokensDesc(a: TokenCounts, b: TokenCounts): number {
  return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
}
