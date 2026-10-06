import type { AggregationRow } from '../aggregate/aggregator';
import { mapToolName } from '../aggregate/builtinTools';
import type { RetrospectiveSignals } from '../analysis/retrospective';
import { LIVE_FINISHED_MS, deriveLiveStatus, type LiveStatus, type LiveTailFacts } from '../live/liveStatus';
import type {
  Interaction,
  SessionDetail,
  SessionModelUsage,
  SessionSummary,
  SessionTimelineEntry,
  SessionTurn,
} from '../telemetry/models';
import { aiuToUsd } from '../telemetry/pricing';
import { UNKNOWN_REPOSITORY, sanitizeRepositorySlug } from '../telemetry/repositoryUrl';
import { eventTimeMs, type CliEvent } from './events';
import type { StoreModelUsage } from './sessionStoreUsage';

/**
 * Maps a Copilot CLI session's events onto the shared session models.
 *
 * Usage semantics, pinned by `mapper.test.ts` against real sessions written
 * by Copilot CLI 1.0.82 and an earlier build:
 * - `session.shutdown` totals are PER PROCESS SEGMENT, not cumulative: a
 *   session resumed five times carries six shutdowns whose output tokens sum
 *   exactly to the per-message `outputTokens`. Segments are therefore summed.
 * - `modelMetrics[model].usage.inputTokens` already includes cache reads.
 * - Billed usage is `totalNanoAiu` (newer builds only). It converts with the
 *   same `aiuToUsd` the VS Code Copilot source uses; a session with no AIU
 *   figure is UNPRICED, never zero.
 * - The still-open segment after the last shutdown has no totals yet: output
 *   tokens come from its messages, AIU from its last `usage_checkpoint`.
 */

/** The two sources that read the runtime's shared session store. */
export type CliSourceId = 'copilot-cli' | 'copilot-app';

export interface CliSessionInput {
  sessionId: string;
  events: readonly CliEvent[];
  workspace: Readonly<Record<string, string>>;
  /** Already resolved and sanitized; see {@link resolveCliRepository}. */
  repository: string;
  /** Which client wrote the session; `copilot-cli` when absent. */
  source?: CliSourceId;
  /**
   * The runtime's own per-model usage for this session, from
   * `session-store.db`. Used only when the events carry no token totals.
   */
  storeUsage?: ReadonlyMap<string, StoreModelUsage>;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The directory the session ran in: workspace.yaml first, then the start event. */
export function cliSessionCwd(workspace: Readonly<Record<string, string>>, events: readonly CliEvent[]): string | undefined {
  if (str(workspace.cwd) !== undefined) {
    return workspace.cwd;
  }
  for (const event of events) {
    if (event.type === 'session.start' || event.type === 'session.resume') {
      const cwd = str(obj(event.data.context).cwd);
      if (cwd !== undefined) {
        return cwd;
      }
    }
  }
  return undefined;
}

/**
 * The repository in the SAME sanitized `https://host/owner/repo` form every
 * other source uses, so hubs merge across sources: workspace.yaml, then the
 * start/resume context, then the caller's cwd-to-remote lookup, else unknown.
 */
export function resolveCliRepository(
  workspace: Readonly<Record<string, string>>,
  events: readonly CliEvent[],
  resolveCwd?: (cwd: string) => string | undefined,
): string {
  const candidates: (string | undefined)[] = [str(workspace.repository)];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].type === 'session.start' || events[i].type === 'session.resume') {
      candidates.push(str(obj(events[i].data.context).repository));
    }
  }
  for (const candidate of candidates) {
    if (candidate !== undefined) {
      const sanitized = sanitizeRepositorySlug(candidate);
      if (sanitized !== UNKNOWN_REPOSITORY) {
        return sanitized;
      }
    }
  }
  const cwd = cliSessionCwd(workspace, events);
  const known = (repo: string | undefined): repo is string => repo !== undefined && repo !== UNKNOWN_REPOSITORY;
  const fromCwd = cwd !== undefined ? resolveCwd?.(cwd) : undefined;
  if (known(fromCwd)) {
    return fromCwd;
  }
  // The Copilot app runs each chat in its own scratch folder and names the
  // project only as an attached directory. Only the remote is kept, never
  // the path.
  for (const dir of attachedDirectories(events)) {
    const repo = resolveCwd?.(dir);
    if (known(repo)) {
      return repo;
    }
  }
  return UNKNOWN_REPOSITORY;
}

/** Directories the user attached to a prompt, in order, without duplicates. */
function attachedDirectories(events: readonly CliEvent[]): string[] {
  const dirs: string[] = [];
  for (const event of events) {
    if (event.type !== 'user.message' || !Array.isArray(event.data.attachments)) {
      continue;
    }
    for (const attachment of event.data.attachments) {
      const a = obj(attachment);
      const dir = str(a.path);
      if (a.type === 'directory' && dir !== undefined && !dirs.includes(dir)) {
        dirs.push(dir);
      }
    }
  }
  return dirs;
}

export interface CliUsage {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  /** Absent when no segment reported billed usage: the session is unpriced. */
  aiuNano?: number;
  byModel: Map<string, { llmCalls: number; inputTokens: number; outputTokens: number; cachedTokens: number; reasoningTokens: number }>;
}

/**
 * Event usage, or the runtime store's when the events carry no token totals
 * at all (the Copilot app never writes `session.shutdown`; a killed CLI
 * process skips it). Billed AIU stays the events' figure when they have one.
 */
export function resolveCliUsage(events: readonly CliEvent[], store?: ReadonlyMap<string, StoreModelUsage>): CliUsage {
  const fromEvents = summarizeCliUsage(events);
  if (store === undefined || store.size === 0 || fromEvents.inputTokens + fromEvents.cachedTokens > 0) {
    return fromEvents;
  }
  const usage: CliUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, byModel: new Map() };
  let storeAiu = 0;
  for (const [model, u] of store) {
    usage.byModel.set(model, {
      llmCalls: u.llmCalls,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cachedTokens: u.cachedTokens,
      reasoningTokens: u.reasoningTokens,
    });
    usage.inputTokens += u.inputTokens;
    usage.outputTokens += u.outputTokens;
    usage.cachedTokens += u.cachedTokens;
    usage.reasoningTokens += u.reasoningTokens;
    storeAiu += u.aiuNano;
  }
  const aiuNano = fromEvents.aiuNano ?? (storeAiu > 0 ? storeAiu : undefined);
  if (aiuNano !== undefined) {
    usage.aiuNano = aiuNano;
  }
  return usage;
}

export function summarizeCliUsage(events: readonly CliEvent[]): CliUsage {
  const usage: CliUsage = { inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0, byModel: new Map() };
  const model = (name: string) => {
    let entry = usage.byModel.get(name);
    if (entry === undefined) {
      entry = { llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 };
      usage.byModel.set(name, entry);
    }
    return entry;
  };
  let aiu: number | undefined;
  let openOutput = 0;
  let openCheckpoint: number | undefined;
  const openCalls = new Map<string, number>();
  const closeOpenCalls = (): void => {
    openCalls.clear();
    openOutput = 0;
    openCheckpoint = undefined;
  };

  for (const event of events) {
    if (event.type === 'assistant.message') {
      openOutput += num(event.data.outputTokens);
      const name = str(event.data.model) ?? 'unknown';
      openCalls.set(name, (openCalls.get(name) ?? 0) + 1);
    } else if (event.type === 'session.usage_checkpoint') {
      if (typeof event.data.totalNanoAiu === 'number') {
        openCheckpoint = event.data.totalNanoAiu;
      }
    } else if (event.type === 'session.shutdown') {
      const metrics = obj(event.data.modelMetrics);
      const names = Object.keys(metrics);
      if (names.length > 0) {
        for (const name of names) {
          const u = obj(obj(metrics[name]).usage);
          const entry = model(name);
          entry.llmCalls += num(obj(obj(metrics[name]).requests).count);
          entry.inputTokens += num(u.inputTokens);
          entry.outputTokens += num(u.outputTokens);
          entry.cachedTokens += num(u.cacheReadTokens);
          entry.reasoningTokens += num(u.reasoningTokens);
        }
      } else {
        const details = obj(event.data.tokenDetails);
        const count = (key: string): number => num(obj(details[key]).tokenCount);
        const entry = model(str(event.data.currentModel) ?? 'unknown');
        entry.inputTokens += count('input') + count('cache_read') + count('cache_write');
        entry.outputTokens += count('output');
        entry.cachedTokens += count('cache_read');
      }
      if (typeof event.data.totalNanoAiu === 'number') {
        aiu = (aiu ?? 0) + event.data.totalNanoAiu;
      }
      closeOpenCalls();
    }
  }
  // The open segment: no shutdown has reported it yet.
  for (const [name, calls] of openCalls) {
    model(name).llmCalls += calls;
  }
  if (openOutput > 0) {
    model([...openCalls.keys()][0] ?? 'unknown').outputTokens += openOutput;
  }
  if (openCheckpoint !== undefined) {
    aiu = (aiu ?? 0) + openCheckpoint;
  }
  for (const entry of usage.byModel.values()) {
    usage.inputTokens += entry.inputTokens;
    usage.outputTokens += entry.outputTokens;
    usage.cachedTokens += entry.cachedTokens;
    usage.reasoningTokens += entry.reasoningTokens;
  }
  if (aiu !== undefined) {
    usage.aiuNano = aiu;
  }
  return usage;
}

interface Walk {
  turns: SessionTurn[];
  interactions: Interaction[];
  llmCalls: number;
  toolCalls: number;
  errorCount: number;
  startedAtMs: number;
  endedAtMs: number;
  dominantModel: string;
  firstPrompt?: string;
}

function walk(input: CliSessionInput): Walk {
  const turns: SessionTurn[] = [];
  const interactions: Interaction[] = [];
  const pending = new Map<string, { name: string; startMs: number; model: string; turn: SessionTurn | undefined }>();
  const modelCalls = new Map<string, number>();
  let current: SessionTurn | undefined;
  let lastMs = 0;
  let firstMs = 0;
  let prevMs = 0;
  let llmCalls = 0;
  let toolCalls = 0;
  let errorCount = 0;
  let firstPrompt: string | undefined;

  const newTurn = (timestampMs: number, userRequest?: string): SessionTurn => {
    const turn: SessionTurn = {
      timestampMs,
      agentMode: 'agent',
      model: 'unknown',
      durationMs: 0,
      success: true,
      ...(userRequest !== undefined ? { userRequest } : {}),
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
      events: [],
    };
    turns.push(turn);
    return turn;
  };
  const record = (turn: SessionTurn, entry: SessionTimelineEntry, spanId?: string): void => {
    turn.events.push(entry);
    turn.durationMs = Math.max(turn.durationMs, entry.timestampMs + entry.durationMs - turn.timestampMs);
    interactions.push({
      timestampMs: entry.timestampMs,
      sessionId: input.sessionId,
      traceId: input.sessionId,
      ...(spanId !== undefined ? { spanId } : {}),
      operation: entry.operation,
      agentName: input.source ?? 'copilot-cli',
      agentMode: entry.agentMode,
      model: entry.model,
      ...(entry.toolName !== undefined ? { toolName: entry.toolName } : {}),
      durationMs: entry.durationMs,
      success: entry.success,
      inputTokens: 0,
      outputTokens: entry.operation === 'chat' ? lastOutput : 0,
      cachedTokens: 0,
      repository: input.repository,
    });
  };
  let lastOutput = 0;

  for (const event of input.events) {
    const ms = eventTimeMs(event) ?? lastMs;
    if (firstMs === 0 && ms > 0) {
      firstMs = ms;
    }
    lastMs = Math.max(lastMs, ms);
    if (event.type === 'user.message') {
      const text = str(event.data.content);
      firstPrompt ??= text;
      current = newTurn(ms, text);
    } else if (event.type === 'assistant.message') {
      current ??= newTurn(ms);
      const model = str(event.data.model) ?? 'unknown';
      modelCalls.set(model, (modelCalls.get(model) ?? 0) + 1);
      llmCalls += 1;
      lastOutput = num(event.data.outputTokens);
      current.llmCalls += 1;
      current.outputTokens += lastOutput;
      current.model = model;
      const content = str(event.data.content);
      const requests = Array.isArray(event.data.toolRequests) ? event.data.toolRequests.length : 0;
      if (content !== undefined && requests === 0) {
        current.finalResponse = content;
      }
      record(current, {
        timestampMs: prevMs > 0 && prevMs <= ms ? prevMs : ms,
        operation: 'chat',
        agentMode: 'agent',
        model,
        durationMs: prevMs > 0 && prevMs <= ms ? ms - prevMs : 0,
        success: true,
      }, str(event.data.messageId));
    } else if (event.type === 'tool.execution_start') {
      const id = str(event.data.toolCallId);
      if (id !== undefined) {
        pending.set(id, {
          name: str(event.data.toolName) ?? 'unknown',
          startMs: ms,
          model: str(event.data.model) ?? current?.model ?? 'unknown',
          turn: current,
        });
      }
    } else if (event.type === 'tool.execution_complete') {
      const id = str(event.data.toolCallId);
      const started = id !== undefined ? pending.get(id) : undefined;
      if (id !== undefined && started !== undefined) {
        pending.delete(id);
        const success = event.data.success !== false;
        toolCalls += 1;
        if (!success) {
          errorCount += 1;
        }
        const turn = started.turn ?? current ?? newTurn(started.startMs);
        if (!success) {
          turn.success = false;
        }
        record(turn, {
          timestampMs: started.startMs,
          operation: 'execute_tool',
          agentMode: 'agent',
          model: started.model,
          toolName: started.name,
          durationMs: Math.max(0, ms - started.startMs),
          success,
        }, id);
      }
    } else if (event.type === 'session.error') {
      errorCount += 1;
    }
    if (event.type !== 'session.usage_checkpoint' && ms > 0) {
      prevMs = ms;
    }
  }
  // A tool that started and never completed still happened; it is counted,
  // with no duration and no failure, so an interrupted session is not blamed.
  for (const [id, started] of pending) {
    toolCalls += 1;
    record(started.turn ?? current ?? newTurn(started.startMs), {
      timestampMs: started.startMs,
      operation: 'execute_tool',
      agentMode: 'agent',
      model: started.model,
      toolName: started.name,
      durationMs: 0,
      success: true,
    }, id);
  }
  const dominantModel = [...modelCalls.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'unknown';
  return {
    turns,
    interactions,
    llmCalls,
    toolCalls,
    errorCount,
    startedAtMs: firstMs,
    endedAtMs: lastMs,
    dominantModel,
    ...(firstPrompt !== undefined ? { firstPrompt } : {}),
  };
}

const TITLE_MAX_CHARS = 80;

export function buildCliSessionDetail(input: CliSessionInput): SessionDetail {
  const w = walk(input);
  const usage = resolveCliUsage(input.events, input.storeUsage);
  const source = input.source ?? 'copilot-cli';
  const named = str(input.workspace.name) ?? str(input.workspace.summary);
  const derived = w.firstPrompt?.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX_CHARS);
  const title = named ?? (derived !== undefined && derived.length > 0 ? derived : undefined);
  const costMicros = usage.aiuNano === undefined ? undefined : Math.round(aiuToUsd(usage.aiuNano) * 1_000_000);
  const summary: SessionSummary = {
    sessionId: input.sessionId,
    repository: input.repository,
    startedAtMs: w.startedAtMs,
    endedAtMs: w.endedAtMs,
    durationMs: Math.max(0, w.endedAtMs - w.startedAtMs),
    interactionCount: w.llmCalls + w.toolCalls,
    llmCalls: w.llmCalls,
    toolCalls: w.toolCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedTokens,
    ...(costMicros !== undefined ? { costMicros } : {}),
    model: w.dominantModel,
    agentModes: w.turns.length > 0 ? ['agent'] : [],
    ...(title !== undefined ? { title, titleDerived: named === undefined } : {}),
    source,
  };
  const models = [...usage.byModel.entries()];
  const modelUsage: SessionModelUsage[] = models.map(([model, u], index) => ({
    model,
    llmCalls: u.llmCalls,
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens,
    cachedTokens: u.cachedTokens,
    reasoningTokens: u.reasoningTokens,
    // Billed usage is per session, not per model: attribute it to the first row.
    aiuNano: index === 0 ? (usage.aiuNano ?? 0) : 0,
  }));
  return {
    summary,
    treeStats: {
      modelTurns: w.llmCalls,
      toolCalls: w.toolCalls,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedTokens: usage.cachedTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      errorCount: w.errorCount,
      aiuNano: usage.aiuNano ?? 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    },
    turns: w.turns,
    modelUsage,
    agentUsage: modelUsage.map((u) => ({
      agentName: source,
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

export function buildCliInteractions(input: CliSessionInput): Interaction[] {
  return walk(input).interactions;
}

/** Content-free rows for the aggregate contract. Tool names pass the shared allowlist. */
export function buildCliAggregationRows(input: CliSessionInput, sinceMs?: number, untilMs?: number): AggregationRow[] {
  return walk(input)
    .interactions.filter(
      (i) => (sinceMs === undefined || i.timestampMs >= sinceMs) && (untilMs === undefined || i.timestampMs < untilMs),
    )
    .map((i) => {
      const toolName = i.operation === 'execute_tool' ? mapToolName(i.toolName) : undefined;
      return {
        startTimeMs: i.timestampMs,
        sessionKey: input.sessionId,
        repository: input.repository,
        model: i.model,
        agentMode: i.agentMode,
        operation: i.operation,
        ...(toolName !== undefined ? { toolName } : {}),
        durationMs: i.durationMs,
        statusCode: i.success ? 1 : 2,
        inputTokens: 0,
        outputTokens: i.outputTokens,
        cachedTokens: 0,
      };
    });
}

/** Counts and enums only: the retrospective's transcript-level signals. */
export function extractCliRetrospectiveSignals(events: readonly CliEvent[]): RetrospectiveSignals {
  let interruptionCount = 0;
  let compactionCount = 0;
  let planModeUsed = false;
  let apiErrorCount = 0;
  for (const event of events) {
    if (event.type === 'user.message' && event.data.delivery === 'steering') {
      interruptionCount += 1;
    } else if (event.type === 'session.compaction_complete') {
      compactionCount += 1;
    } else if (event.type === 'session.mode_changed' && String(event.data.newMode ?? '').toLowerCase().includes('plan')) {
      planModeUsed = true;
    } else if (event.type === 'session.error') {
      apiErrorCount += 1;
    }
  }
  const last = lastSubstantive(events);
  const lastEvent: RetrospectiveSignals['lastEvent'] =
    last === undefined
      ? 'unknown'
      : last.type === 'user.message'
        ? 'user-request'
        : last.type === 'tool.execution_complete'
          ? 'tool-result'
          : last.type === 'assistant.message' || last.type === 'assistant.turn_end'
            ? 'assistant-response'
            : 'unknown';
  return { interruptionCount, endedWithInterruption: false, compactionCount, planModeUsed, apiErrorCount, lastEvent };
}

const SUBSTANTIVE = new Set([
  'user.message',
  'assistant.message',
  'assistant.turn_start',
  'assistant.turn_end',
  'tool.execution_start',
  'tool.execution_complete',
  'session.shutdown',
]);

function lastSubstantive(events: readonly CliEvent[]): CliEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (SUBSTANTIVE.has(events[i].type)) {
      return events[i];
    }
  }
  return undefined;
}

/**
 * Live status from the tail of the events file. Newer runtimes (and sessions
 * hosted through the Copilot SDK) persist `permission.requested` /
 * `permission.completed`, which makes "waiting for approval" exact. Older
 * sessions have neither, so a tool call asked for but not started reads as
 * pending and the board's existing hint covers it. A trailing
 * `session.shutdown` means the process ended.
 */
export function deriveCliLive(
  events: readonly CliEvent[],
  fileMtimeMs: number,
  nowMs: number,
): { facts: LiveTailFacts; status: LiveStatus; awaitingApproval: boolean } {
  const started = new Map<string, string>();
  const requested = new Map<string, string>();
  const openPermissions = new Set<string>();
  let model: string | undefined;
  let lastMs = fileMtimeMs;
  let lastCompleteFailed = false;
  for (const event of events) {
    lastMs = Math.max(lastMs, eventTimeMs(event) ?? 0);
    if (event.type === 'assistant.message') {
      model = str(event.data.model) ?? model;
      for (const request of Array.isArray(event.data.toolRequests) ? event.data.toolRequests : []) {
        const id = str(obj(request).toolCallId);
        if (id !== undefined) {
          requested.set(id, str(obj(request).name) ?? 'tool');
        }
      }
    } else if (event.type === 'tool.execution_start') {
      const id = str(event.data.toolCallId);
      if (id !== undefined) {
        requested.delete(id);
        started.set(id, str(event.data.toolName) ?? 'tool');
      }
    } else if (event.type === 'tool.execution_complete') {
      const id = str(event.data.toolCallId);
      if (id !== undefined) {
        started.delete(id);
        requested.delete(id);
      }
      lastCompleteFailed = event.data.success === false;
    } else if (event.type === 'permission.requested') {
      // Only the request id is kept: the command text, file name and diff the
      // event carries are raw content and are never read here.
      const id = str(event.data.requestId);
      if (id !== undefined) {
        openPermissions.add(id);
      }
    } else if (event.type === 'permission.completed') {
      const id = str(event.data.requestId);
      if (id !== undefined) {
        openPermissions.delete(id);
      }
    } else if (event.type === 'user.message') {
      requested.clear();
    }
  }
  const pendingTools = [...started.values(), ...requested.values()];
  const last = lastSubstantive(events);
  const lastEvent: LiveTailFacts['lastEvent'] =
    pendingTools.length > 0
      ? 'tool-pending'
      : last === undefined
        ? 'unknown'
        : last.type === 'assistant.turn_end'
          ? 'turn-ended'
          : last.type === 'assistant.message'
            ? 'assistant-text'
            : last.type === 'user.message'
              ? 'user-prompt'
              : last.type === 'tool.execution_complete'
                ? 'tool-result'
                : 'unknown';
  const facts: LiveTailFacts = {
    lastActivityMs: lastMs,
    lastEvent,
    pendingTools,
    ...(model !== undefined ? { model } : {}),
    ...(lastEvent === 'tool-result' && lastCompleteFailed ? { lastToolFailed: true } : {}),
  };
  const finished = last?.type === 'session.shutdown' || nowMs - lastMs >= LIVE_FINISHED_MS;
  // Newer runtimes persist permission requests. An unanswered one is exact:
  // the session is waiting for the user, however long ago it asked.
  const status: LiveStatus = finished ? 'finished' : openPermissions.size > 0 ? 'waiting' : deriveLiveStatus(facts, nowMs);
  return { facts, status, awaitingApproval: !finished && openPermissions.size > 0 };
}
