import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AggregationRow } from '../aggregate/aggregator';
import type { Interaction, SessionDetail, SessionModelUsage, SessionSummary, SessionTurn } from '../telemetry/models';
import { UNKNOWN_REPOSITORY, sanitizeRepositorySlug } from '../telemetry/repositoryUrl';
import type { JetbrainsConversation } from './nitriteScan';
import type { JetbrainsStoreFile } from './paths';

/**
 * Maps one Copilot JetBrains conversation onto the shared session models.
 *
 * The plugin records no token counts and no billed usage, so every token
 * figure is zero and no cost is set: the session is unpriced, never $0.
 * A turn without its own time takes the store file's mtime.
 */

export interface JetbrainsSessionInput {
  sessionId: string;
  store: JetbrainsStoreFile;
  conversation: JetbrainsConversation;
  /** Already resolved and sanitized; see {@link resolveJetbrainsRepository}. */
  repository: string;
  defaultModel?: string;
}

const AGENT_NAME = 'copilot-jetbrains';
const TITLE_MAX_CHARS = 80;

/** A conversation's id; the legacy layout has none, so one is derived from the store path. */
export function jetbrainsSessionId(store: JetbrainsStoreFile, conversation: JetbrainsConversation, index: number): string {
  if (conversation.id !== undefined) {
    return conversation.id;
  }
  const hash = createHash('sha256').update(`${store.path}#${index}`).digest('hex').slice(0, 24);
  return `jb-${hash}`;
}

/**
 * `projectName` when it is an `owner/repo` or a remote, else the git remote
 * of the first referenced file's repository, else unknown. The conversation
 * title is a thread name, never a project, and is not used.
 */
export function resolveJetbrainsRepository(
  conversation: JetbrainsConversation,
  resolveDir?: (dir: string) => string | undefined,
): string {
  const fromName = sanitizeRepositorySlug(conversation.projectName);
  if (fromName !== UNKNOWN_REPOSITORY) {
    return fromName;
  }
  for (const uri of conversation.fileUris) {
    let file: string;
    try {
      file = fileURLToPath(uri);
    } catch {
      continue;
    }
    const repo = resolveDir?.(path.dirname(file));
    if (repo !== undefined && repo !== UNKNOWN_REPOSITORY) {
      return repo;
    }
  }
  return UNKNOWN_REPOSITORY;
}

interface Walked {
  turns: SessionTurn[];
  interactions: Interaction[];
  startedAtMs: number;
  endedAtMs: number;
  modelCalls: Map<string, number>;
}

function walk(input: JetbrainsSessionInput): Walked {
  const turns: SessionTurn[] = [];
  const interactions: Interaction[] = [];
  const modelCalls = new Map<string, number>();
  let startedAtMs = 0;
  let endedAtMs = 0;
  for (const [index, t] of input.conversation.turns.entries()) {
    const ms = t.timestampMs ?? input.store.mtimeMs;
    startedAtMs = startedAtMs === 0 ? ms : Math.min(startedAtMs, ms);
    endedAtMs = Math.max(endedAtMs, ms);
    const model = t.model ?? input.defaultModel ?? 'unknown';
    modelCalls.set(model, (modelCalls.get(model) ?? 0) + 1);
    const agentMode = t.mode === 'agent' ? 'agent' : 'ask';
    turns.push({
      timestampMs: ms,
      agentMode,
      model,
      durationMs: 0,
      success: t.reply !== undefined,
      ...(t.prompt !== undefined ? { userRequest: t.prompt } : {}),
      ...(t.reply !== undefined ? { finalResponse: t.reply } : {}),
      llmCalls: 1,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
      events: [{ timestampMs: ms, operation: 'chat', agentMode, model, durationMs: 0, success: t.reply !== undefined }],
    });
    interactions.push({
      timestampMs: ms,
      sessionId: input.sessionId,
      traceId: input.sessionId,
      spanId: `${input.sessionId}:${index}`,
      operation: 'chat',
      agentName: AGENT_NAME,
      agentMode,
      model,
      durationMs: 0,
      success: t.reply !== undefined,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      repository: input.repository,
    });
  }
  return { turns, interactions, startedAtMs, endedAtMs, modelCalls };
}

export function buildJetbrainsSessionDetail(input: JetbrainsSessionInput): SessionDetail {
  const w = walk(input);
  const dominantModel =
    [...w.modelCalls.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'unknown';
  const named = input.conversation.title?.trim();
  const firstPrompt = input.conversation.turns.find((t) => t.prompt !== undefined)?.prompt;
  const derived = firstPrompt?.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS);
  const title = named !== undefined && named.length > 0 ? named : derived !== undefined && derived.length > 0 ? derived : undefined;
  const modes = [...new Set(w.turns.map((t) => t.agentMode))];
  const summary: SessionSummary = {
    sessionId: input.sessionId,
    repository: input.repository,
    startedAtMs: w.startedAtMs,
    endedAtMs: w.endedAtMs,
    durationMs: Math.max(0, w.endedAtMs - w.startedAtMs),
    interactionCount: w.turns.length,
    llmCalls: w.turns.length,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    model: dominantModel,
    agentModes: modes,
    ...(title !== undefined ? { title, titleDerived: !(named !== undefined && named.length > 0) } : {}),
    source: 'copilot-jetbrains',
  };
  const modelUsage: SessionModelUsage[] = [...w.modelCalls.entries()].map(([model, calls]) => ({
    model,
    llmCalls: calls,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    aiuNano: 0,
  }));
  return {
    summary,
    treeStats: {
      modelTurns: w.turns.length,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      errorCount: w.turns.filter((t) => !t.success).length,
      aiuNano: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    },
    turns: w.turns,
    modelUsage,
    agentUsage: modelUsage.map((u) => ({
      agentName: AGENT_NAME,
      kind: 'main' as const,
      ...u,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    })),
    treeModelTurns: [],
  };
}

export function buildJetbrainsInteractions(input: JetbrainsSessionInput): Interaction[] {
  return walk(input).interactions;
}

/** Content-free rows for the aggregate contract: one chat row per turn. */
export function buildJetbrainsAggregationRows(input: JetbrainsSessionInput, sinceMs?: number, untilMs?: number): AggregationRow[] {
  return walk(input)
    .interactions.filter(
      (i) => (sinceMs === undefined || i.timestampMs >= sinceMs) && (untilMs === undefined || i.timestampMs < untilMs),
    )
    .map((i) => ({
      startTimeMs: i.timestampMs,
      sessionKey: input.sessionId,
      repository: input.repository,
      model: i.model,
      agentMode: i.agentMode,
      operation: i.operation,
      durationMs: 0,
      statusCode: i.success ? 1 : 2,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
    }));
}
