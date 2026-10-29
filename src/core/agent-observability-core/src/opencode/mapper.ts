import type { AggregationRow } from '../aggregate/aggregator';
import { mapToolName } from '../aggregate/builtinTools';
import type {
  AgentMode,
  Interaction,
  SessionAgentUsage,
  SessionDetail,
  SessionModelTurnPoint,
  SessionModelUsage,
  SessionSummary,
  SessionTimelineEntry,
  SessionTurn,
} from '../telemetry/models';
import { agentUsageKey } from '../telemetry/models';
import { UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';
import type {
  OpencodeInstructionLoad,
  OpencodeMessageRow,
  OpencodeSessionRow,
  OpencodeStore,
  OpencodeToolPart,
} from './store';

/**
 * Maps OpenCode sessions onto the shared session models.
 *
 * - One root session per row; sub-agent sessions (`parent_id` set) fold into
 *   their root as `subagent` usage, the way Claude Code's sub-agents do.
 * - A turn is a user message plus the assistant messages answering it: by
 *   `parentID` in the 1.x layout, else the replies that follow it in order
 *   (2.x). Each assistant message is one LLM call; each tool call one tool
 *   call.
 * - The model shows as `provider/model` (`github-copilot/gpt-5.4`), so a
 *   Copilot-served turn is visible as such.
 * - Tokens follow the Claude convention: input counts cache writes, cached
 *   counts cache reads, and the two never overlap.
 * - Cost is the USD OpenCode recorded per message. Turns served through a
 *   GitHub Copilot login are billed as Copilot premium requests; OpenCode
 *   records an API list-price estimate for them instead, which is not what
 *   Copilot charges, so they stay unpriced rather than $0 or that estimate.
 */

export const COPILOT_PROVIDERS: ReadonlySet<string> = new Set(['github-copilot', 'github-copilot-enterprise']);

const MAIN_AGENT = 'opencode';
const TITLE_MAX_CHARS = 80;
/** OpenCode names a session this way until its title is generated. */
const PLACEHOLDER_TITLE = /^(new|child) session - \d{4}-\d{2}-\d{2}t/i;

export interface OpencodeThread {
  session: OpencodeSessionRow;
  messages: OpencodeMessageRow[];
  tools: OpencodeToolPart[];
  /** Instruction files this session loaded (for the Context Analysis tab). */
  instructions: OpencodeInstructionLoad[];
}

export interface OpencodeSessionInput extends OpencodeThread {
  /** Already resolved and sanitized. */
  repository: string;
  /** User and assistant text by message id, for titles and the detail view. */
  texts: ReadonlyMap<string, string>;
  /** Every sub-agent session below this one, at any depth. */
  children: OpencodeThread[];
}

/**
 * The root sessions in a store, newest first. `resolveRepository` gets the
 * session's directory (else the project worktree).
 */
export function groupOpencodeSessions(
  store: OpencodeStore,
  resolveRepository: (dir: string | undefined) => string,
): OpencodeSessionInput[] {
  const byId = new Map(store.sessions.map((s) => [s.id, s]));
  const messages = groupBy(store.messages, (m) => m.sessionId);
  const tools = groupBy(store.tools, (t) => t.sessionId);
  const instructions = groupBy(store.instructions, (i) => i.sessionId);
  const texts = new Map<string, string>();
  for (const t of store.texts) {
    const prior = texts.get(t.messageId);
    texts.set(t.messageId, prior === undefined ? t.text : `${prior}\n\n${t.text}`);
  }
  const rootOf = (s: OpencodeSessionRow): OpencodeSessionRow => {
    let current = s;
    const seen = new Set<string>([s.id]);
    while (current.parentId !== undefined) {
      const parent = byId.get(current.parentId);
      if (parent === undefined || seen.has(parent.id)) {
        break;
      }
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  const thread = (s: OpencodeSessionRow): OpencodeThread => ({
    session: s,
    messages: messages.get(s.id) ?? [],
    tools: tools.get(s.id) ?? [],
    instructions: instructions.get(s.id) ?? [],
  });
  const roots = new Map<string, OpencodeSessionInput>();
  for (const s of store.sessions) {
    if (rootOf(s) === s) {
      roots.set(s.id, {
        ...thread(s),
        repository: resolveRepository(s.directory ?? s.worktree),
        texts,
        children: [],
      });
    }
  }
  for (const s of store.sessions) {
    const root = rootOf(s);
    if (root !== s) {
      roots.get(root.id)?.children.push(thread(s));
    }
  }
  return [...roots.values()]
    .filter((input) => input.messages.length > 0 || input.children.some((c) => c.messages.length > 0))
    .sort((a, b) => lastActivity(b) - lastActivity(a));
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(key(item));
    if (list === undefined) {
      out.set(key(item), [item]);
    } else {
      list.push(item);
    }
  }
  return out;
}

/** `build` writes, `plan` only reads; anything else is a user-defined agent. */
export function opencodeAgentMode(agent: string | undefined): AgentMode {
  if (agent === undefined) {
    return 'default';
  }
  const key = agent.toLowerCase();
  return key === 'build' ? 'agent' : key === 'plan' ? 'ask' : 'custom';
}

export function opencodeModel(m: Pick<OpencodeMessageRow, 'providerId' | 'modelId'>): string {
  if (m.modelId === undefined) {
    return 'unknown';
  }
  return m.providerId !== undefined ? `${m.providerId}/${m.modelId}` : m.modelId;
}

const isPriced = (m: OpencodeMessageRow): boolean =>
  m.cost !== undefined && !(m.providerId !== undefined && COPILOT_PROVIDERS.has(m.providerId));
const micros = (usd: number): number => Math.round(usd * 1_000_000);
const inputOf = (m: OpencodeMessageRow): number => m.inputTokens + m.cacheWriteTokens;
const endOf = (m: OpencodeMessageRow): number => Math.max(m.createdMs, m.completedMs ?? 0);
const toolEnd = (t: OpencodeToolPart): number => Math.max(t.startMs, t.endMs ?? 0);
const toolFailed = (t: OpencodeToolPart): boolean => t.status === 'error';

function lastActivity(input: OpencodeSessionInput): number {
  let last = 0;
  for (const t of [input, ...input.children]) {
    for (const m of t.messages) {
      last = Math.max(last, endOf(m));
    }
    for (const tool of t.tools) {
      last = Math.max(last, toolEnd(tool));
    }
  }
  return last || input.session.updatedMs;
}

/** The agent a sub-agent session ran as (`explore`, `general`, …). */
export function subagentName(t: OpencodeThread): string {
  return t.messages.find((m) => m.role === 'assistant' && m.agent !== undefined)?.agent ?? 'subagent';
}

/** The mode a thread's assistant message ran in: its own agent, else the user message's. */
function modeOf(m: OpencodeMessageRow, byId: ReadonlyMap<string, OpencodeMessageRow>): AgentMode {
  const user = m.parentId !== undefined ? byId.get(m.parentId) : undefined;
  return opencodeAgentMode(user?.agent ?? m.agent);
}

interface Walked {
  turns: SessionTurn[];
  interactions: Interaction[];
}

function walkThread(input: OpencodeSessionInput, t: OpencodeThread, agentName: string): Walked {
  const byId = new Map(t.messages.map((m) => [m.id, m]));
  const toolsByMessage = groupBy(t.tools, (tool) => tool.messageId);
  const interactions: Interaction[] = [];
  for (const m of t.messages) {
    if (m.role !== 'assistant') {
      continue;
    }
    const agentMode = modeOf(m, byId);
    const model = opencodeModel(m);
    interactions.push({
      timestampMs: m.createdMs,
      sessionId: input.session.id,
      traceId: t.session.id,
      spanId: m.id,
      operation: 'chat',
      agentName,
      agentMode,
      model,
      durationMs: Math.max(0, endOf(m) - m.createdMs),
      success: m.error === undefined,
      inputTokens: inputOf(m),
      outputTokens: m.outputTokens,
      cachedTokens: m.cacheReadTokens,
      repository: input.repository,
    });
    for (const tool of toolsByMessage.get(m.id) ?? []) {
      interactions.push({
        timestampMs: tool.startMs,
        sessionId: input.session.id,
        traceId: t.session.id,
        spanId: `${m.id}:${tool.tool}:${tool.startMs}`,
        operation: 'execute_tool',
        agentName,
        agentMode,
        model,
        toolName: tool.tool,
        durationMs: Math.max(0, toolEnd(tool) - tool.startMs),
        success: !toolFailed(tool),
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        repository: input.repository,
      });
    }
  }
  return { turns: t === input ? buildTurns(input, byId, toolsByMessage) : [], interactions };
}

function buildTurns(
  input: OpencodeSessionInput,
  byId: ReadonlyMap<string, OpencodeMessageRow>,
  toolsByMessage: ReadonlyMap<string, OpencodeToolPart[]>,
): SessionTurn[] {
  const groups: { user?: OpencodeMessageRow; replies: OpencodeMessageRow[] }[] = [];
  const byUser = new Map<string, { user?: OpencodeMessageRow; replies: OpencodeMessageRow[] }>();
  for (const m of input.messages) {
    if (m.role === 'user') {
      const group = { user: m, replies: [] };
      groups.push(group);
      byUser.set(m.id, group);
      continue;
    }
    const group = (m.parentId !== undefined ? byUser.get(m.parentId) : undefined) ?? groups[groups.length - 1];
    if (group === undefined) {
      groups.push({ replies: [m] });
    } else {
      group.replies.push(m);
    }
  }
  return groups.map(({ user, replies }) => {
    const timestampMs = user?.createdMs ?? replies[0]?.createdMs ?? input.session.createdMs;
    const agentMode = opencodeAgentMode(user?.agent ?? replies[0]?.agent);
    const last = replies[replies.length - 1];
    const model = last !== undefined ? opencodeModel(last) : user !== undefined ? opencodeModel(user) : 'unknown';
    const events: SessionTimelineEntry[] = [];
    let endMs = timestampMs;
    for (const m of replies) {
      const mode = modeOf(m, byId);
      events.push({
        timestampMs: m.createdMs,
        operation: 'chat',
        agentMode: mode,
        model: opencodeModel(m),
        durationMs: Math.max(0, endOf(m) - m.createdMs),
        success: m.error === undefined,
      });
      endMs = Math.max(endMs, endOf(m));
      for (const tool of toolsByMessage.get(m.id) ?? []) {
        events.push({
          timestampMs: tool.startMs,
          operation: 'execute_tool',
          agentMode: mode,
          model: opencodeModel(m),
          toolName: tool.tool,
          durationMs: Math.max(0, toolEnd(tool) - tool.startMs),
          success: !toolFailed(tool),
        });
        endMs = Math.max(endMs, toolEnd(tool));
      }
    }
    const userRequest = user !== undefined ? input.texts.get(user.id) : undefined;
    const answer = [...replies].reverse().find((m) => input.texts.has(m.id));
    const finalResponse = answer !== undefined ? input.texts.get(answer.id) : undefined;
    return {
      timestampMs,
      agentMode,
      model,
      durationMs: Math.max(0, endMs - timestampMs),
      success: replies.length > 0 && replies.every((m) => m.error === undefined),
      ...(userRequest !== undefined ? { userRequest } : {}),
      ...(finalResponse !== undefined ? { finalResponse } : {}),
      llmCalls: replies.length,
      inputTokens: sum(replies, inputOf),
      outputTokens: sum(replies, (m) => m.outputTokens),
      cachedTokens: sum(replies, (m) => m.cacheReadTokens),
      reasoningTokens: sum(replies, (m) => m.reasoningTokens),
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
      events,
    };
  });
}

function sum<T>(items: readonly T[], of: (item: T) => number): number {
  return items.reduce((n, item) => n + of(item), 0);
}

/** Priced USD in micro-dollars, or `undefined` when nothing in `messages` carries a price. */
function costMicrosOf(messages: readonly OpencodeMessageRow[]): number | undefined {
  const priced = messages.filter((m) => m.role === 'assistant' && isPriced(m));
  return priced.length === 0 ? undefined : sum(priced, (m) => micros(m.cost ?? 0));
}

function titleOf(input: OpencodeSessionInput): { title: string; titleDerived: boolean } | undefined {
  const named = input.session.title?.trim();
  if (named !== undefined && named.length > 0 && !PLACEHOLDER_TITLE.test(named)) {
    return { title: named, titleDerived: false };
  }
  const firstUser = input.messages.find((m) => m.role === 'user' && input.texts.has(m.id));
  const derived = firstUser !== undefined ? input.texts.get(firstUser.id)?.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS) : undefined;
  return derived !== undefined && derived.length > 0 ? { title: derived, titleDerived: true } : undefined;
}

export function buildOpencodeSessionDetail(input: OpencodeSessionInput): SessionDetail {
  const main = walkThread(input, input, MAIN_AGENT);
  const subs = input.children.map((c) => ({ thread: c, name: subagentName(c), walked: walkThread(input, c, subagentName(c)) }));
  const mainReplies = input.messages.filter((m) => m.role === 'assistant');
  const allThreads: { thread: OpencodeThread; name: string; kind: 'main' | 'subagent' }[] = [
    { thread: input, name: MAIN_AGENT, kind: 'main' },
    ...subs.map((s) => ({ thread: s.thread, name: s.name, kind: 'subagent' as const })),
  ];
  const allReplies = allThreads.flatMap((t) => t.thread.messages.filter((m) => m.role === 'assistant'));
  const allTools = allThreads.flatMap((t) => t.thread.tools);

  const calls = new Map<string, number>();
  for (const m of mainReplies.length > 0 ? mainReplies : allReplies) {
    calls.set(opencodeModel(m), (calls.get(opencodeModel(m)) ?? 0) + 1);
  }
  const dominantModel = [...calls.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'unknown';
  const startedAtMs = input.session.createdMs || (input.messages[0]?.createdMs ?? 0);
  const endedAtMs = Math.max(startedAtMs, lastActivity(input));
  const title = titleOf(input);
  const mainCost = costMicrosOf(input.messages);
  const summary: SessionSummary = {
    sessionId: input.session.id,
    repository: input.repository,
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    interactionCount: main.interactions.length,
    llmCalls: mainReplies.length,
    toolCalls: input.tools.length,
    inputTokens: sum(mainReplies, inputOf),
    outputTokens: sum(mainReplies, (m) => m.outputTokens),
    cachedTokens: sum(mainReplies, (m) => m.cacheReadTokens),
    ...(mainCost !== undefined ? { costMicros: mainCost } : {}),
    model: dominantModel,
    agentModes: [...new Set(main.turns.map((t) => t.agentMode))],
    ...(title !== undefined ? title : {}),
    source: 'opencode',
  };

  const modelUsage = new Map<string, SessionModelUsage>();
  const agentUsage = new Map<string, SessionAgentUsage>();
  const treeModelTurns: SessionModelTurnPoint[] = [];
  for (const { thread, name, kind } of allThreads) {
    for (const m of thread.messages) {
      if (m.role !== 'assistant') {
        continue;
      }
      const model = opencodeModel(m);
      const priced = isPriced(m);
      const usage = modelUsage.get(model) ?? {
        model,
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        aiuNano: 0,
      };
      addUsage(usage, m, priced);
      modelUsage.set(model, usage);
      const key = agentUsageKey({ agentName: name, model, kind });
      const agent = agentUsage.get(key) ?? {
        agentName: name,
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
      addUsage(agent, m, priced);
      agentUsage.set(key, agent);
      treeModelTurns.push({
        timestampMs: m.createdMs,
        model,
        inputTokens: inputOf(m),
        outputTokens: m.outputTokens,
        cachedTokens: m.cacheReadTokens,
        reasoningTokens: m.reasoningTokens,
        linesOfCode: 0,
        linesOfDoc: 0,
        linesOfCodeRemoved: 0,
        linesOfDocRemoved: 0,
      });
    }
  }
  treeModelTurns.sort((a, b) => a.timestampMs - b.timestampMs);

  const treeInput = sum(allReplies, inputOf);
  const treeOutput = sum(allReplies, (m) => m.outputTokens);
  const treeCached = sum(allReplies, (m) => m.cacheReadTokens);
  const treeCost = costMicrosOf(allReplies);
  return {
    summary,
    treeStats: {
      modelTurns: allReplies.length,
      toolCalls: allTools.length,
      inputTokens: treeInput,
      outputTokens: treeOutput,
      cachedTokens: treeCached,
      totalTokens: treeInput + treeCached + treeOutput,
      errorCount: allReplies.filter((m) => m.error !== undefined).length + allTools.filter(toolFailed).length,
      aiuNano: 0,
      ...(treeCost !== undefined ? { costUsdMicros: treeCost } : {}),
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    },
    turns: main.turns,
    modelUsage: [...modelUsage.values()].sort(
      (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
    ),
    agentUsage: [...agentUsage.values()],
    treeModelTurns,
  };
}

function addUsage(row: SessionModelUsage, m: OpencodeMessageRow, priced: boolean): void {
  row.llmCalls += 1;
  row.inputTokens += inputOf(m);
  row.outputTokens += m.outputTokens;
  row.cachedTokens += m.cacheReadTokens;
  row.reasoningTokens += m.reasoningTokens;
  if (priced) {
    row.costUsdMicros = (row.costUsdMicros ?? 0) + micros(m.cost ?? 0);
  }
}

/** Every LLM and tool call in the session, sub-agents included. */
export function buildOpencodeInteractions(input: OpencodeSessionInput): Interaction[] {
  return [
    ...walkThread(input, input, MAIN_AGENT).interactions,
    ...input.children.flatMap((c) => walkThread(input, c, subagentName(c)).interactions),
  ].sort((a, b) => a.timestampMs - b.timestampMs);
}

/** Content-free rows for the aggregate contract: one row per LLM or tool call. */
export function buildOpencodeAggregationRows(input: OpencodeSessionInput, sinceMs?: number, untilMs?: number): AggregationRow[] {
  return buildOpencodeInteractions(input)
    .filter((i) => (sinceMs === undefined || i.timestampMs >= sinceMs) && (untilMs === undefined || i.timestampMs < untilMs))
    .map((i) => ({
      startTimeMs: i.timestampMs,
      sessionKey: input.session.id,
      repository: input.repository || UNKNOWN_REPOSITORY,
      model: i.model,
      agentMode: i.agentMode,
      operation: i.operation,
      ...(i.operation === 'execute_tool' ? { toolName: mapToolName(i.toolName) } : {}),
      durationMs: i.durationMs,
      statusCode: i.success ? 1 : 2,
      inputTokens: i.inputTokens,
      outputTokens: i.outputTokens,
      cachedTokens: i.cachedTokens,
    }));
}
