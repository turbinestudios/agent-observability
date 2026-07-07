import {
  CombinedSessionDetail,
  CombinedSummary,
  SessionAgentUsage,
  SessionDetail,
  SessionModelUsage,
  SessionTreeStats,
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
 * CAVEAT: each session's `modelUsage`/`agentUsage` is now whole-agent-tree scoped
 * (see `TelemetryDatabase.treeUsageRollups`). Independent sessions never share a
 * tree, so merging unrelated selections is exact; but if the user selects BOTH an
 * orchestrator AND one of its own spawned sub-agents (two nodes of the same tree),
 * that sub-agent's `chat` usage is included by each and double-counts on merge.
 * The combined header `summary` is unaffected (it sums each session's main-thread
 * {@link SessionSummary}). A full fix would aggregate once over the union of the
 * selected sessions' tree ids — deferred as out of scope.
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
    treeStats: mergeTreeStats(details),
    modelUsage: mergeModelUsage(details),
    agentUsage: mergeAgentUsage(details),
  };
}

/**
 * Sum every session's whole-agent-tree totals into one {@link SessionTreeStats}.
 * Each field adds directly; {@link SessionTreeStats.totalTokens} is re-derived as
 * input + cached + output (the disjoint buckets' true total) so it stays consistent
 * regardless of the per-session value. Shares
 * the tree-overlap CAVEAT above: selecting an orchestrator and its own sub-agent
 * would double-count, but independent selections sum exactly.
 */
function mergeTreeStats(details: readonly SessionDetail[]): SessionTreeStats {
  const acc: SessionTreeStats = {
    modelTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    errorCount: 0,
    aiuNano: 0,
    costUsdMicros: 0,
    creditsNano: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
  };
  for (const { treeStats: t } of details) {
    acc.modelTurns += t.modelTurns;
    acc.toolCalls += t.toolCalls;
    acc.inputTokens += t.inputTokens;
    acc.outputTokens += t.outputTokens;
    acc.cachedTokens += t.cachedTokens;
    acc.errorCount += t.errorCount;
    acc.aiuNano += t.aiuNano;
    // Claude carries token-priced USD here (Copilot's is absent → 0); summing
    // keeps the combined "Agent run totals" cost tile correct for Claude.
    acc.costUsdMicros = (acc.costUsdMicros ?? 0) + (t.costUsdMicros ?? 0);
    // Copilot (Cloud) carries AI credits here (local sources' is absent → 0).
    acc.creditsNano = (acc.creditsNano ?? 0) + (t.creditsNano ?? 0);
    acc.linesOfCode += t.linesOfCode;
    acc.linesOfDoc += t.linesOfDoc;
    acc.linesOfCodeRemoved += t.linesOfCodeRemoved;
    acc.linesOfDocRemoved += t.linesOfDocRemoved;
  }
  acc.totalTokens = acc.inputTokens + acc.cachedTokens + acc.outputTokens;
  return acc;
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
        // LoC/LoD live only on agentUsage (not the shared TokenCounts), so sum them
        // here so the merged per-agent lines reconcile with the merged tree totals.
        existing.linesOfCode += u.linesOfCode;
        existing.linesOfDoc += u.linesOfDoc;
        existing.linesOfCodeRemoved += u.linesOfCodeRemoved;
        existing.linesOfDocRemoved += u.linesOfDocRemoved;
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
  aiuNano: number;
  /** Claude token-priced USD (micro-USD); absent for Copilot (uses aiuNano). */
  costUsdMicros?: number;
  /** Copilot (Cloud) AI credits (nano-credits); absent for local sources. */
  creditsNano?: number;
}

function addTokens(into: TokenCounts, from: TokenCounts): void {
  into.llmCalls += from.llmCalls;
  into.inputTokens += from.inputTokens;
  into.outputTokens += from.outputTokens;
  into.cachedTokens += from.cachedTokens;
  into.reasoningTokens += from.reasoningTokens;
  into.aiuNano += from.aiuNano;
  into.costUsdMicros = (into.costUsdMicros ?? 0) + (from.costUsdMicros ?? 0);
  into.creditsNano = (into.creditsNano ?? 0) + (from.creditsNano ?? 0);
}

/** Sort by input+output tokens descending (the renderer's stable ordering). */
function byTotalTokensDesc(a: TokenCounts, b: TokenCounts): number {
  return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
}
