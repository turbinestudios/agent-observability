import type {
  AgentMode,
  OverviewMetrics,
  RepositorySummary,
  SessionSummary,
} from '../../telemetry/models';

/**
 * Pure digest + prompt construction for the "Summarize my logs" task.
 *
 * PRIVACY BOUNDARY. The summary is sent to the user's Copilot model, so the
 * digest must carry SAFE METADATA ONLY. {@link toSafeSessionRow} is the explicit
 * projection: it copies named safe fields and deliberately OMITS
 * `SessionSummary.title` (which may be derived from the user's first request) and
 * never touches raw content. The privacy regression test asserts a title marker
 * never reaches the digest.
 */

/** A session projected to safe fields only — no `title`, no raw content. */
export interface SafeSessionRow {
  repository: string;
  startedAtMs: number;
  durationMs: number;
  interactionCount: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  model: string;
  agentModes: AgentMode[];
}

/** Project a {@link SessionSummary} to a {@link SafeSessionRow} (drops `title`). */
export function toSafeSessionRow(s: SessionSummary): SafeSessionRow {
  return {
    repository: s.repository,
    startedAtMs: s.startedAtMs,
    durationMs: s.durationMs,
    interactionCount: s.interactionCount,
    llmCalls: s.llmCalls,
    toolCalls: s.toolCalls,
    inputTokens: s.inputTokens,
    outputTokens: s.outputTokens,
    cachedTokens: s.cachedTokens,
    model: s.model,
    agentModes: [...s.agentModes],
  };
}

/** Inputs for the summary digest (all safe metadata). */
export interface SummaryInput {
  overview: OverviewMetrics;
  sessions: SafeSessionRow[];
  repositories: RepositorySummary[];
}

/** Build a compact, safe-metadata digest of the collected telemetry. */
export function buildSummaryDigest(input: SummaryInput): string {
  const { overview, sessions, repositories } = input;
  const sections: string[] = [];

  sections.push(
    [
      '## Overview',
      `- Interactions: ${overview.totalInteractions}`,
      `- Sessions: ${overview.totalSessions}`,
      `- Repositories: ${overview.totalRepositories}`,
      `- Distinct models: ${overview.totalModels}`,
      `- Avg interaction duration: ${seconds(overview.avgDurationMs)}`,
      `- Tokens — input: ${overview.inputTokens}, output: ${overview.outputTokens}, cached: ${overview.cachedTokens}`,
      `- Errors: ${overview.errorCount}`,
    ].join('\n'),
  );

  if (repositories.length > 0) {
    const rows = repositories
      .slice(0, 10)
      .map(
        (r) =>
          `- ${r.repository}: ${r.sessionCount} session(s), ${r.interactionCount} interaction(s), models: ${csv(r.models)}`,
      );
    sections.push(`## Repositories\n${rows.join('\n')}`);
  }

  const byModel = aggregateTokensByModel(sessions);
  if (byModel.length > 0) {
    const rows = byModel
      .slice(0, 10)
      .map((m) => `- ${m.model}: ${m.llmSessions} session(s), in ${m.inputTokens} / out ${m.outputTokens} / cached ${m.cachedTokens}`);
    sections.push(`## Token usage by model\n${rows.join('\n')}`);
  }

  return sections.join('\n\n');
}

/** Assemble the grounding preamble for the log-summary request. */
export function buildLogSummaryPreamble(contextText: string, digest: string): string {
  return [
    contextText,
    '',
    digest,
    '',
    '## Task',
    'Write a clear, detailed summary of the collected telemetry above. Cover overall activity, the',
    'busiest repositories, model usage, token spend, and any error hotspots, and finish with 1–3',
    'concrete suggestions. Use ONLY the numbers in the digest — never invent figures.',
  ].join('\n');
}

interface ModelTokens {
  model: string;
  llmSessions: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

/** Sum token counts per session-responding model, busiest first. */
function aggregateTokensByModel(sessions: readonly SafeSessionRow[]): ModelTokens[] {
  const byModel = new Map<string, ModelTokens>();
  for (const s of sessions) {
    const acc = byModel.get(s.model) ?? {
      model: s.model,
      llmSessions: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    };
    acc.llmSessions += 1;
    acc.inputTokens += s.inputTokens;
    acc.outputTokens += s.outputTokens;
    acc.cachedTokens += s.cachedTokens;
    byModel.set(s.model, acc);
  }
  return [...byModel.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
}

/** Comma-join with an empty-list fallback. */
function csv(values: readonly string[]): string {
  return values.length > 0 ? values.join(', ') : 'none';
}

/** Human-readable seconds for a millisecond duration. */
function seconds(ms: number): string {
  return `${Math.round(ms / 1000)}s`;
}
