/**
 * Parser for a Copilot cloud coding-agent **CAPI session log**
 * (`GET {capiBase}/agents/sessions/{id}/logs`).
 *
 * The body is an SSE stream of `data: {…}` lines (no `event:` lines, no `[DONE]`).
 * A single 92-second session already carried THREE distinct payload shapes, so
 * this parser is deliberately tolerant: an unknown shape is skipped and counted
 * ({@link ParsedCloudLog.skipped}), never thrown — a drifting preview format must
 * degrade a session to metadata-only, not crash it. The raw SSE is archived in the
 * sink so a parser upgrade ({@link CLOUD_PARSER_VERSION}) can re-derive everything.
 *
 * The three observed shapes (plan §1.2):
 *  1. Completion chunks (`chat.completion.chunk`): `delta.content`,
 *     `delta.tool_calls[{id, function{name, arguments}}]`, `finish_reason`,
 *     `created`, chunk `id`. Tool invocations pair a start (zero-content) and a
 *     completion (content-bearing) chunk; the `finish_reason:"stop"` chunk holds
 *     the final answer. `usage` is opportunistic (unobserved on enterprise CAPI).
 *  2. Bare `role:"user"` messages — the first is the real prompt; a later one is
 *     a platform-injected PR housekeeping prompt that must NOT be surfaced.
 *  3. Bare `role:"tool"` result messages — `tool_call_id` joins the invocation.
 *
 * Pure (no `vscode`, no IO) — unit-tested directly.
 */

import {
  CloudLogTokenUsage,
  CloudToolInvocation,
  ParsedCloudLog,
  normalizeEpochMs,
} from './cloudTypes';

/** Setup infrastructure ops (clone, MCP-server starts) — excluded from tool metrics. */
function isSetupToolName(name: string): boolean {
  return /^run_setup\b/i.test(name) || name.toLowerCase() === 'setup';
}

/**
 * Heuristic: is this a platform-injected PR title/description housekeeping prompt
 * (never a real user request)? Matches GitHub's fixed metadata templates.
 */
export function isHousekeepingUserPrompt(text: string): boolean {
  const t = text.toLowerCase();
  // The platform housekeeping prompt always asks the agent to generate a PULL
  // REQUEST title/description. Gate on that context so a legitimate user request
  // that merely mentions "a title and a description" (e.g. of a UI form) is NOT
  // dropped as a false positive.
  const mentionsPullRequest = t.includes('pull request') || /\bpr\b/.test(t);
  if (!mentionsPullRequest) {
    return false;
  }
  return t.includes('title') || t.includes('description') || t.includes('summariz');
}

/** Extract plain text from a message `content` that may be a string or content blocks. */
function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      if (typeof block === 'string') {
        parts.push(block);
      } else if (block !== null && typeof block === 'object') {
        const b = block as { type?: string; text?: unknown };
        if (typeof b.text === 'string') {
          parts.push(b.text);
        }
      }
    }
    return parts.join('');
  }
  return '';
}

interface CompletionChoice {
  delta?: { content?: unknown; tool_calls?: unknown };
  finish_reason?: string | null;
}

/** Mutable accumulator for one invocation while streaming. */
interface InvocationAcc {
  id: string;
  name: string;
  startedAtMs: number;
  endedAtMs?: number;
  success: boolean;
  isSetup: boolean;
}

/** Read the `data:` JSON payload from an SSE line, or `undefined` for non-data lines. */
function dataPayload(line: string): string | undefined {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith('data:')) {
    return undefined;
  }
  return trimmed.slice('data:'.length).trim();
}

/**
 * Parse a raw CAPI SSE log into a normalized {@link ParsedCloudLog}. Never throws;
 * unparseable / unknown lines are counted in `skipped`.
 */
export function parseCloudSessionLog(raw: string): ParsedCloudLog {
  const userRequests: string[] = [];
  const invocations = new Map<string, InvocationAcc>();
  const turnIds = new Set<string>();
  const finalParts: string[] = [];
  let usagePrompt = 0;
  let usageCompletion = 0;
  let usageCached = 0;
  let sawUsage = false;
  let skipped = 0;

  for (const line of raw.split(/\r?\n/)) {
    const payload = dataPayload(line);
    if (payload === undefined || payload.length === 0) {
      continue;
    }
    if (payload === '[DONE]') {
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(payload);
    } catch {
      skipped++;
      continue;
    }
    if (obj === null || typeof obj !== 'object') {
      skipped++;
      continue;
    }
    const rec = obj as Record<string, unknown>;

    // Shape 2/3: bare role-tagged messages (no id/created/model).
    const role = typeof rec.role === 'string' ? rec.role : undefined;
    if (role === 'user') {
      const text = contentText(rec.content);
      if (text.length > 0 && !isHousekeepingUserPrompt(text)) {
        userRequests.push(text);
      }
      continue;
    }
    if (role === 'tool') {
      // A tool result: join to its invocation by tool_call_id, flag errors.
      const toolCallId = typeof rec.tool_call_id === 'string' ? rec.tool_call_id : undefined;
      const isError = rec.is_error === true;
      if (toolCallId !== undefined) {
        const inv = invocations.get(toolCallId);
        if (inv !== undefined && isError) {
          inv.success = false;
        }
      }
      continue;
    }

    // Shape 1: completion chunk.
    const choices = Array.isArray(rec.choices) ? (rec.choices as CompletionChoice[]) : undefined;
    const choice = choices?.[0];
    const delta = choice?.delta ?? (rec.delta as CompletionChoice['delta'] | undefined);
    const finishReason =
      choice?.finish_reason ?? (typeof rec.finish_reason === 'string' ? rec.finish_reason : undefined);
    const chunkId = typeof rec.id === 'string' ? rec.id : undefined;
    const createdMs = normalizeEpochMs(typeof rec.created === 'number' ? rec.created : undefined);

    const isCompletionChunk =
      rec.object === 'chat.completion.chunk' ||
      choices !== undefined ||
      delta !== undefined ||
      finishReason !== undefined;
    if (!isCompletionChunk) {
      skipped++;
      continue;
    }

    if (chunkId !== undefined) {
      turnIds.add(chunkId);
    }

    // Opportunistic usage (feature-real, unobserved on enterprise CAPI).
    const usage = rec.usage as
      | { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
      | undefined;
    if (usage !== null && typeof usage === 'object') {
      sawUsage = true;
      usagePrompt += num(usage.prompt_tokens);
      usageCompletion += num(usage.completion_tokens);
      usageCached += num(usage.prompt_tokens_details?.cached_tokens);
    }

    // Tool calls: key each invocation by its stable tool_calls[].id (fall back to
    // the chunk id). First sighting = start; a later sighting = completion.
    const toolCalls = Array.isArray(delta?.tool_calls) ? (delta?.tool_calls as unknown[]) : [];
    for (const tc of toolCalls) {
      if (tc === null || typeof tc !== 'object') {
        continue;
      }
      const call = tc as { id?: unknown; function?: { name?: unknown } };
      const fnName = typeof call.function?.name === 'string' ? call.function.name : undefined;
      const invId = typeof call.id === 'string' ? call.id : chunkId;
      if (invId === undefined) {
        continue;
      }
      const existing = invocations.get(invId);
      if (existing === undefined) {
        invocations.set(invId, {
          id: invId,
          name: fnName ?? 'tool',
          startedAtMs: createdMs ?? 0,
          success: true,
          isSetup: isSetupToolName(fnName ?? ''),
        });
      } else {
        if (fnName !== undefined && (existing.name === 'tool' || existing.name.length === 0)) {
          existing.name = fnName;
          existing.isSetup = isSetupToolName(fnName);
        }
        if (createdMs !== undefined) {
          existing.endedAtMs = Math.max(existing.endedAtMs ?? createdMs, createdMs);
        }
      }
    }

    // The single `stop` chunk carries the assistant's final answer.
    if (finishReason === 'stop') {
      const text = contentText(delta?.content);
      if (text.length > 0) {
        finalParts.push(text);
      }
    }
  }

  const toolInvocations: CloudToolInvocation[] = [...invocations.values()]
    .map((inv) => ({
      id: inv.id,
      name: inv.name,
      startedAtMs: inv.startedAtMs,
      endedAtMs: inv.endedAtMs,
      durationMs:
        inv.endedAtMs !== undefined && inv.startedAtMs > 0
          ? Math.max(0, inv.endedAtMs - inv.startedAtMs)
          : 0,
      success: inv.success,
      isSetup: inv.isSetup,
    }))
    .sort((a, b) => a.startedAtMs - b.startedAtMs);

  let tokenUsage: CloudLogTokenUsage | undefined;
  if (sawUsage) {
    tokenUsage = {
      // OpenAI `prompt_tokens` INCLUDES cached — subtract to keep buckets disjoint.
      inputTokens: Math.max(0, usagePrompt - usageCached),
      cachedTokens: usageCached,
      outputTokens: usageCompletion,
    };
  }

  return {
    userRequests,
    toolInvocations,
    finalResponse: finalParts.length > 0 ? finalParts.join('') : undefined,
    tokenUsage,
    // Distinct chunk ids ≈ the platform turn counter.
    llmTurns: turnIds.size,
    skipped,
  };
}

/** Coerce an unknown to a non-negative finite integer, else 0. */
function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}
