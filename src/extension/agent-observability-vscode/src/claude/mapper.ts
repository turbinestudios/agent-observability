/**
 * Map parsed Claude Code transcripts onto the SAME internal model shapes the
 * Copilot path produces (`../telemetry/models.ts`), so the unified views and the
 * session-detail webview render Claude sessions with no source-specific branches
 * beyond the cost basis (Claude is priced by tokens, not AIU — see
 * `./pricing.ts` and {@link ../telemetry/models.SessionTreeStats.costUsdMicros}).
 *
 * Semantics mirror the Copilot mapping:
 * - The "main thread" is the main transcript; spawned sub-agents are the
 *   `subagents/` side-chains. {@link buildSessionSummary} counts the main thread
 *   only (so cross-session sums never double-count); {@link buildSessionDetail}'s
 *   tree rollups INCLUDE sub-agents (matching the "Agent run totals" card).
 * - An LLM call = one `assistant` message; a tool call = one `tool_use` block; a
 *   sub-agent spawn = a `Task`/`Agent` tool call (→ `invoke_agent`).
 *
 * Pure: no `vscode`, no I/O — operates on already-parsed {@link TranscriptRecord}
 * arrays the service hands in, so it is fully headless-testable. Raw content
 * (`userRequest`/`finalResponse`) is carried ONLY for the local webview and never
 * reaches {@link buildAggregationRows} (the cloud-safe, content-free path).
 */

import {
  AgentSourceId,
  Interaction,
  Operation,
  SessionAgentUsage,
  SessionDetail,
  SessionModelTurnPoint,
  SessionModelUsage,
  SessionSummary,
  SessionTimelineEntry,
  SessionTreeStats,
  SessionTurn,
  agentUsageKey,
} from '../telemetry/models';
import { AggregationRow } from '../aggregate/aggregator';
import { mapToolName } from '../aggregate/builtinTools';
import { sanitizeModelId } from '../aggregate/modelId';
import { UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';
import { countClaudeWrittenLines, WriteLineDelta } from '../telemetry/locAnalysis';
import { claudeCostMicros } from './pricing';
import {
  ContentBlock,
  TranscriptMessage,
  TranscriptRecord,
  contentBlocks,
  isAssistant,
  messageText,
} from './transcript';

export const CLAUDE_SOURCE: AgentSourceId = 'claude';
/** Claude Code is agentic; map to the aggregate schema's `agent` mode. */
const CLAUDE_AGENT_MODE = 'agent';
/**
 * Tool names that spawn a sub-agent — classified as `invoke_agent`, not
 * `execute_tool`. `Task` is the standard Claude Code spawner; `Agent` and
 * `Workflow` are this CLI build's spawners (verified in real transcripts: a
 * `Workflow` fan-out writes its children under `subagents/workflows/wf_<id>/`).
 */
const SUBAGENT_TOOLS: ReadonlySet<string> = new Set(['Task', 'Agent', 'Workflow']);

/** A parsed sub-agent side-chain plus its friendly type, if known. */
export interface ClaudeSubagentTranscript {
  /** Friendly agent type/name (e.g. `Explore`, `Plan`, `general-purpose`). */
  agentType?: string;
  records: TranscriptRecord[];
}

/** Everything the mapper needs for one session. */
export interface ClaudeSessionInput {
  sessionId: string;
  /** Main transcript records (may be empty if only sub-agent files survive). */
  mainRecords: TranscriptRecord[];
  /** Parsed sub-agent side-chains. */
  subagents: ClaudeSubagentTranscript[];
  /** SANITIZED repository (already resolved from `cwd`). */
  repository: string;
  /**
   * Raw working directory of the session (from the transcript records), used
   * LOCAL-ONLY by the context analyzer to locate the CLAUDE.md / `.claude`
   * hierarchy. Never uploaded — the cloud path carries only {@link repository}.
   */
  cwd?: string;
  /** Code/doc extension lists for LoC classification (normalized). */
  codeExts: readonly string[];
  docExts: readonly string[];
}

/** One extracted `assistant` turn with its triggered tool calls. */
interface ExtractedTurn {
  timestampMs: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /**
   * `cache_creation_input_tokens`, ALREADY folded into {@link inputTokens} for
   * display (cache writes are fresh, near-full-price input). Kept separately only
   * so {@link buildAggregationRows} can subtract it back out and upload RAW
   * `input_tokens` to the cloud — the org-sync contract predates this fold.
   */
  cacheCreationTokens: number;
  reasoningTokens: number;
  costMicros: number;
  /** Approx generation latency (ms): gap from the previous record. */
  durationMs: number;
  success: boolean;
  tools: ExtractedTool[];
  /** Sum of this turn's tool-call line deltas (LoC/LoD added/removed). */
  loc: WriteLineDelta;
  /** Assistant final text (for the detail view's final response). */
  responseText: string;
}

/** One `tool_use` block resolved against its `tool_result`. */
interface ExtractedTool {
  id?: string;
  name: string;
  input: unknown;
  timestampMs: number;
  durationMs: number;
  success: boolean;
  isSubagentSpawn: boolean;
  loc: WriteLineDelta;
}

// ── Public mapping API ─────────────────────────────────────────────────────────

/**
 * Main-thread session summary (sub-agents EXCLUDED), for the Sessions list.
 * Lighter than {@link buildSessionDetail}: needs only the main records.
 */
export function buildSessionSummary(
  input: Pick<ClaudeSessionInput, 'sessionId' | 'mainRecords' | 'repository' | 'codeExts' | 'docExts'>,
): SessionSummary {
  const { records: turns } = extractTranscript(input.mainRecords, input.codeExts, input.docExts);
  const { startedAtMs, endedAtMs } = timeBounds(input.mainRecords);

  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let toolCalls = 0;
  const modelCounts = new Map<string, number>();
  for (const turn of turns) {
    inputTokens += turn.inputTokens;
    outputTokens += turn.outputTokens;
    cachedTokens += turn.cachedTokens;
    toolCalls += turn.tools.length;
    modelCounts.set(turn.model, (modelCounts.get(turn.model) ?? 0) + 1);
  }

  const title = resolveTitle(input.mainRecords);
  return {
    sessionId: input.sessionId,
    repository: input.repository.length > 0 ? input.repository : UNKNOWN_REPOSITORY,
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
    interactionCount: turns.length + toolCalls,
    llmCalls: turns.length,
    toolCalls,
    inputTokens,
    outputTokens,
    cachedTokens,
    model: dominantModel(modelCounts),
    agentModes: [CLAUDE_AGENT_MODE],
    source: CLAUDE_SOURCE,
    ...(title !== undefined ? { title: title.title, titleDerived: title.derived } : {}),
  };
}

/** Full drill-down for the LOCAL detail panel (tree rollups include sub-agents). */
export function buildSessionDetail(input: ClaudeSessionInput): SessionDetail {
  const summary = buildSessionSummary(input);

  // Tree = main thread + every sub-agent side-chain.
  const main = extractTranscript(input.mainRecords, input.codeExts, input.docExts);
  const subExtracts = input.subagents.map((sub) => ({
    agentType: sub.agentType,
    extract: extractTranscript(sub.records, input.codeExts, input.docExts),
  }));

  const treeStats = buildTreeStats(main.records, subExtracts);
  const modelUsage = buildModelUsage(main.records, subExtracts);
  const agentUsage = buildAgentUsage(main.records, subExtracts);
  const treeModelTurns = buildTreeModelTurns(main.records, subExtracts);
  const turns = buildMainTurns(input.mainRecords, input.codeExts, input.docExts);

  return { summary, treeStats, turns, modelUsage, agentUsage, treeModelTurns };
}

/**
 * Safe-metadata main-thread interactions for the LOCAL deviation detector
 * (operation / agentName / agentMode / model / toolName / success). Carries no
 * raw content.
 */
export function buildInteractions(input: ClaudeSessionInput): Interaction[] {
  const { records: turns } = extractTranscript(input.mainRecords, input.codeExts, input.docExts);
  const out: Interaction[] = [];
  for (const turn of turns) {
    out.push({
      timestampMs: turn.timestampMs,
      sessionId: input.sessionId,
      traceId: input.sessionId,
      operation: 'chat',
      agentName: 'claude',
      agentMode: CLAUDE_AGENT_MODE,
      model: turn.model,
      durationMs: turn.durationMs,
      success: turn.success,
      inputTokens: turn.inputTokens,
      outputTokens: turn.outputTokens,
      cachedTokens: turn.cachedTokens,
      repository: input.repository,
    });
    for (const tool of turn.tools) {
      out.push({
        timestampMs: tool.timestampMs,
        sessionId: input.sessionId,
        traceId: input.sessionId,
        operation: tool.isSubagentSpawn ? 'invoke_agent' : 'execute_tool',
        agentName: 'claude',
        agentMode: CLAUDE_AGENT_MODE,
        model: turn.model,
        ...(tool.isSubagentSpawn ? {} : { toolName: tool.name }),
        durationMs: tool.durationMs,
        success: tool.success,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        repository: input.repository,
      });
    }
  }
  return out;
}

/**
 * Cloud-safe per-event aggregation rows over the WHOLE tree (no raw content) for
 * the sync engine. Tokens live only on `chat` rows; `invoke_agent` (sub-agent
 * spawn) and `execute_tool` rows carry 0 tokens, so summing never double-counts a
 * sub-agent (whose tokens are on its own `chat` rows). Tool names pass through the
 * shared {@link mapToolName} allowlist (non-builtin → `custom`).
 */
export function buildAggregationRows(input: ClaudeSessionInput): AggregationRow[] {
  const repository = input.repository.length > 0 ? input.repository : UNKNOWN_REPOSITORY;
  const rows: AggregationRow[] = [];
  const transcripts = [
    input.mainRecords,
    ...input.subagents.map((s) => s.records),
  ];
  for (const records of transcripts) {
    const { records: turns } = extractTranscript(records, input.codeExts, input.docExts);
    for (const turn of turns) {
      // Contract-safe model id for the cloud batch (Claude ids are already clean,
      // but sanitize defensively — same chokepoint the Copilot path uses).
      const model = sanitizeModelId(turn.model);
      rows.push({
        startTimeMs: turn.timestampMs,
        sessionKey: input.sessionId,
        repository,
        model,
        agentMode: CLAUDE_AGENT_MODE,
        operation: 'chat',
        durationMs: turn.durationMs,
        statusCode: turn.success ? 1 : 2,
        // Cloud keeps RAW `input_tokens`: display folds cache writes into TIN, but
        // the org-sync contract predates that, so subtract them back out here.
        inputTokens: turn.inputTokens - turn.cacheCreationTokens,
        outputTokens: turn.outputTokens,
        cachedTokens: turn.cachedTokens,
        reasoningTokens: turn.reasoningTokens,
      });
      for (const tool of turn.tools) {
        const operation: Operation = tool.isSubagentSpawn ? 'invoke_agent' : 'execute_tool';
        rows.push({
          startTimeMs: tool.timestampMs,
          sessionKey: input.sessionId,
          repository,
          model,
          agentMode: CLAUDE_AGENT_MODE,
          operation,
          ...(operation === 'execute_tool' ? { toolName: mapToolName(tool.name) } : {}),
          durationMs: tool.durationMs,
          statusCode: tool.success ? 1 : 2,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
        });
      }
    }
  }
  return rows;
}

// ── Extraction ───────────────────────────────────────────────────────────────

interface TranscriptExtract {
  records: ExtractedTurn[];
}

/**
 * Extract the ordered `assistant` turns of one transcript, resolving each
 * `tool_use` against its `tool_result` for success + duration. Exported for tests.
 */
export function extractTranscript(
  records: TranscriptRecord[],
  codeExts: readonly string[],
  docExts: readonly string[],
): TranscriptExtract {
  const resultIndex = buildToolResultIndex(records);
  const turns: ExtractedTurn[] = [];
  let prevTs = 0;
  for (const record of records) {
    if (!isAssistant(record)) {
      // Advance the latency baseline past any intervening record with a time.
      const ts = parseTs(record.timestamp);
      if (ts > 0) {
        prevTs = ts;
      }
      continue;
    }
    const turn = extractAssistantTurn(record, resultIndex, prevTs, codeExts, docExts);
    turns.push(turn);
    prevTs = turn.timestampMs > 0 ? turn.timestampMs : prevTs;
  }
  return { records: turns };
}

/** Build `tool_use_id → { isError, ts }` from every `tool_result` block. */
export function buildToolResultIndex(
  records: TranscriptRecord[],
): Map<string, { isError: boolean; ts: number }> {
  const index = new Map<string, { isError: boolean; ts: number }>();
  for (const record of records) {
    if (record.type !== 'user' || record.message === undefined) {
      continue;
    }
    const ts = parseTs(record.timestamp);
    for (const block of contentBlocks(record.message)) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        index.set(block.tool_use_id, { isError: block.is_error === true, ts });
      }
    }
  }
  return index;
}

function extractAssistantTurn(
  record: TranscriptRecord,
  resultIndex: Map<string, { isError: boolean; ts: number }>,
  prevTs: number,
  codeExts: readonly string[],
  docExts: readonly string[],
): ExtractedTurn {
  const message = record.message as TranscriptMessage;
  const ts = parseTs(record.timestamp);
  const model = typeof message.model === 'string' && message.model.length > 0 ? message.model : 'unknown';
  const usage = message.usage;
  // TIN (display) = every input token processed FRESH this turn: uncached
  // `input_tokens` PLUS `cache_creation_input_tokens` (cache writes are new,
  // ~full-price input — not reuse). TCI is the cheap cache READS only. The two are
  // disjoint, mirroring the Copilot path (gross input − cache reads). Cost is
  // unaffected (claudeCostMicros prices all three buckets from `usage` directly),
  // and the cloud batch keeps RAW input (see buildAggregationRows).
  const cacheCreationTokens = intOf(usage?.cache_creation_input_tokens);
  const inputTokens = intOf(usage?.input_tokens) + cacheCreationTokens;
  const outputTokens = intOf(usage?.output_tokens);
  const cachedTokens = intOf(usage?.cache_read_input_tokens);
  const reasoningTokens = intOf(usage?.reasoning_tokens);
  const success = record.isApiErrorMessage !== true && message.stop_reason !== 'refusal';

  const tools: ExtractedTool[] = [];
  for (const block of contentBlocks(message)) {
    if (block.type !== 'tool_use') {
      continue;
    }
    const name = typeof block.name === 'string' ? block.name : '';
    if (name.length === 0) {
      continue;
    }
    const result = block.id !== undefined ? resultIndex.get(block.id) : undefined;
    const toolTs = result !== undefined && result.ts > 0 ? result.ts : ts;
    tools.push({
      id: block.id,
      name,
      input: (block as ContentBlock).input,
      timestampMs: ts,
      durationMs: Math.max(0, toolTs - ts),
      success: result !== undefined ? !result.isError : true,
      isSubagentSpawn: SUBAGENT_TOOLS.has(name),
      loc: countClaudeWrittenLines(name, (block as ContentBlock).input, codeExts, docExts),
    });
  }

  const loc = emptyLoc();
  for (const tool of tools) {
    loc.added.code += tool.loc.added.code;
    loc.added.doc += tool.loc.added.doc;
    loc.removed.code += tool.loc.removed.code;
    loc.removed.doc += tool.loc.removed.doc;
  }

  return {
    timestampMs: ts,
    model,
    inputTokens,
    outputTokens,
    cachedTokens,
    cacheCreationTokens,
    reasoningTokens,
    costMicros: claudeCostMicros(model, usage),
    durationMs: prevTs > 0 && ts > 0 ? Math.max(0, ts - prevTs) : 0,
    success,
    tools,
    loc,
    responseText: messageText(message),
  };
}

/** A zeroed line-delta. */
function emptyLoc(): WriteLineDelta {
  return { added: { code: 0, doc: 0 }, removed: { code: 0, doc: 0 } };
}

// ── Tree rollups ────────────────────────────────────────────────────────────

type SubExtract = { agentType?: string; extract: TranscriptExtract };

function buildTreeStats(main: ExtractedTurn[], subs: SubExtract[]): SessionTreeStats {
  const stats: SessionTreeStats = {
    modelTurns: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    errorCount: 0,
    aiuNano: 0,
    costUsdMicros: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
  };
  const accumulate = (turns: ExtractedTurn[]): void => {
    for (const turn of turns) {
      stats.modelTurns += 1;
      stats.inputTokens += turn.inputTokens;
      stats.outputTokens += turn.outputTokens;
      stats.cachedTokens += turn.cachedTokens;
      stats.costUsdMicros = (stats.costUsdMicros ?? 0) + turn.costMicros;
      if (!turn.success) {
        stats.errorCount += 1;
      }
      for (const tool of turn.tools) {
        stats.toolCalls += 1;
        if (!tool.success) {
          stats.errorCount += 1;
        }
        addLoc(stats, tool.loc);
      }
    }
  };
  accumulate(main);
  for (const sub of subs) {
    accumulate(sub.extract.records);
  }
  // TT is the genuine total: fresh input (TIN) + cache reads (TCI) + output. The
  // three buckets are disjoint, so nothing is double-counted and nothing (incl.
  // cache reads, which the old `input + output` silently dropped) is lost.
  stats.totalTokens = stats.inputTokens + stats.cachedTokens + stats.outputTokens;
  return stats;
}

function buildModelUsage(main: ExtractedTurn[], subs: SubExtract[]): SessionModelUsage[] {
  const byModel = new Map<string, SessionModelUsage>();
  const ensure = (model: string): SessionModelUsage => {
    let row = byModel.get(model);
    if (row === undefined) {
      row = {
        model,
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        aiuNano: 0,
        costUsdMicros: 0,
      };
      byModel.set(model, row);
    }
    return row;
  };
  const accumulate = (turns: ExtractedTurn[]): void => {
    for (const turn of turns) {
      const row = ensure(turn.model);
      row.llmCalls += 1;
      row.inputTokens += turn.inputTokens;
      row.outputTokens += turn.outputTokens;
      row.cachedTokens += turn.cachedTokens;
      row.reasoningTokens += turn.reasoningTokens;
      row.costUsdMicros = (row.costUsdMicros ?? 0) + turn.costMicros;
    }
  };
  accumulate(main);
  for (const sub of subs) {
    accumulate(sub.extract.records);
  }
  return [...byModel.values()].sort(
    (a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens),
  );
}

function buildAgentUsage(main: ExtractedTurn[], subs: SubExtract[]): SessionAgentUsage[] {
  const rows = new Map<string, SessionAgentUsage>();
  const ensure = (agentName: string, model: string, kind: 'main' | 'subagent'): SessionAgentUsage => {
    const key = agentUsageKey({ agentName, model, kind });
    let row = rows.get(key);
    if (row === undefined) {
      row = {
        agentName,
        model,
        kind,
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        aiuNano: 0,
        costUsdMicros: 0,
        linesOfCode: 0,
        linesOfDoc: 0,
        linesOfCodeRemoved: 0,
        linesOfDocRemoved: 0,
      };
      rows.set(key, row);
    }
    return row;
  };
  const accumulate = (turns: ExtractedTurn[], agentName: string, kind: 'main' | 'subagent'): void => {
    for (const turn of turns) {
      const row = ensure(agentName, turn.model, kind);
      row.llmCalls += 1;
      row.inputTokens += turn.inputTokens;
      row.outputTokens += turn.outputTokens;
      row.cachedTokens += turn.cachedTokens;
      row.reasoningTokens += turn.reasoningTokens;
      row.costUsdMicros = (row.costUsdMicros ?? 0) + turn.costMicros;
      for (const tool of turn.tools) {
        addLocToAgent(row, tool.loc);
      }
    }
  };
  accumulate(main, 'Main agent', 'main');
  for (const sub of subs) {
    const name = sub.agentType !== undefined && sub.agentType.length > 0
      ? `Sub-agent: ${sub.agentType}`
      : 'Sub-agent';
    accumulate(sub.extract.records, name, 'subagent');
  }
  // Main first, then by total tokens desc.
  return [...rows.values()].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'main' ? -1 : 1;
    }
    return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
  });
}

function buildTreeModelTurns(main: ExtractedTurn[], subs: SubExtract[]): SessionModelTurnPoint[] {
  const all: ExtractedTurn[] = [...main];
  for (const sub of subs) {
    all.push(...sub.extract.records);
  }
  all.sort((a, b) => a.timestampMs - b.timestampMs);
  return all.map((turn) => ({
    timestampMs: turn.timestampMs,
    model: turn.model,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cachedTokens: turn.cachedTokens,
    reasoningTokens: turn.reasoningTokens,
    linesOfCode: turn.loc.added.code,
    linesOfDoc: turn.loc.added.doc,
    linesOfCodeRemoved: turn.loc.removed.code,
    linesOfDocRemoved: turn.loc.removed.doc,
  }));
}

// ── Main-thread user-request turns (detail timeline) ────────────────────────

/**
 * Group the main transcript into user-request turns: a top-level user prompt and
 * the chronological LLM-call + tool events it triggered, plus the assistant's
 * final response. A leading synthetic turn (no `userRequest`) holds any assistant
 * activity before the first prompt. Summing the turns reproduces the main-thread
 * {@link SessionSummary} token totals.
 */
export function buildMainTurns(
  mainRecords: TranscriptRecord[],
  codeExts: readonly string[],
  docExts: readonly string[],
): SessionTurn[] {
  const resultIndex = buildToolResultIndex(mainRecords);
  const turns: SessionTurn[] = [];
  let current: SessionTurn | undefined;
  let prevTs = 0;

  const startTurn = (timestampMs: number, userRequest: string | undefined): void => {
    if (current !== undefined) {
      turns.push(current);
    }
    current = {
      timestampMs,
      agentMode: CLAUDE_AGENT_MODE,
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
  };

  for (const record of mainRecords) {
    const ts = parseTs(record.timestamp);
    if (isUserRequest(record)) {
      startTurn(ts, messageText(record.message).trim() || undefined);
      prevTs = ts > 0 ? ts : prevTs;
      continue;
    }
    if (!isAssistant(record)) {
      if (ts > 0) {
        prevTs = ts;
      }
      continue;
    }
    if (current === undefined) {
      // Assistant activity before any user request → synthetic leading turn.
      startTurn(ts, undefined);
    }
    const turn = extractAssistantTurn(record, resultIndex, prevTs, codeExts, docExts);
    prevTs = turn.timestampMs > 0 ? turn.timestampMs : prevTs;
    applyTurn(current as SessionTurn, turn);
  }
  if (current !== undefined) {
    turns.push(current);
  }
  return turns;
}

/** Fold one extracted assistant turn into the active user-request turn. */
function applyTurn(group: SessionTurn, turn: ExtractedTurn): void {
  group.llmCalls += 1;
  group.inputTokens += turn.inputTokens;
  group.outputTokens += turn.outputTokens;
  group.cachedTokens += turn.cachedTokens;
  group.reasoningTokens += turn.reasoningTokens;
  group.linesOfCode += turn.loc.added.code;
  group.linesOfDoc += turn.loc.added.doc;
  group.linesOfCodeRemoved += turn.loc.removed.code;
  group.linesOfDocRemoved += turn.loc.removed.doc;
  if (turn.model !== 'unknown') {
    group.model = turn.model;
  }
  if (!turn.success) {
    group.success = false;
  }
  if (turn.responseText.length > 0) {
    group.finalResponse = turn.responseText;
  }
  // The LLM call itself is a `chat` event…
  const chatEvent: SessionTimelineEntry = {
    timestampMs: turn.timestampMs,
    operation: 'chat',
    agentMode: CLAUDE_AGENT_MODE,
    model: turn.model,
    durationMs: turn.durationMs,
    success: turn.success,
  };
  group.events.push(chatEvent);
  // …followed by its tool calls.
  for (const tool of turn.tools) {
    group.events.push({
      timestampMs: tool.timestampMs,
      operation: tool.isSubagentSpawn ? 'invoke_agent' : 'execute_tool',
      agentMode: CLAUDE_AGENT_MODE,
      model: turn.model,
      ...(tool.isSubagentSpawn ? {} : { toolName: tool.name }),
      durationMs: tool.durationMs,
      success: tool.success,
    });
  }
}

// ── Small helpers ───────────────────────────────────────────────────────────

/** Whether a record is a genuine top-level user prompt (turn anchor). */
function isUserRequest(record: TranscriptRecord): boolean {
  if (record.type !== 'user' || record.message === undefined) {
    return false;
  }
  if (record.isMeta === true || record.isSidechain === true) {
    return false;
  }
  const message = record.message;
  if (typeof message.content === 'string') {
    return message.content.trim().length > 0;
  }
  const blocks = contentBlocks(message);
  // A tool-result delivery (only tool_result blocks) is part of the loop, not a
  // new request; a real prompt has at least one text block.
  return blocks.some((b) => b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0);
}

/** Earliest / latest record timestamp (epoch ms), defaulting to 0. */
function timeBounds(records: TranscriptRecord[]): { startedAtMs: number; endedAtMs: number } {
  let started = 0;
  let ended = 0;
  for (const record of records) {
    const ts = parseTs(record.timestamp);
    if (ts <= 0) {
      continue;
    }
    if (started === 0 || ts < started) {
      started = ts;
    }
    if (ts > ended) {
      ended = ts;
    }
  }
  return { startedAtMs: started, endedAtMs: ended };
}

/**
 * Resolve a session title: the latest `ai-title` record (authoritative), else a
 * `summary` record, else the first user request's text (derived).
 */
function resolveTitle(
  records: TranscriptRecord[],
): { title: string; derived: boolean } | undefined {
  let aiTitle: string | undefined;
  let summary: string | undefined;
  let firstRequest: string | undefined;
  for (const record of records) {
    if (record.type === 'ai-title' && typeof record.aiTitle === 'string' && record.aiTitle.trim().length > 0) {
      aiTitle = record.aiTitle.trim();
    } else if (record.type === 'summary' && typeof record.summary === 'string' && record.summary.trim().length > 0) {
      summary = record.summary.trim();
    } else if (firstRequest === undefined && isUserRequest(record)) {
      const text = messageText(record.message).trim();
      if (text.length > 0) {
        firstRequest = text;
      }
    }
  }
  if (aiTitle !== undefined) {
    return { title: aiTitle, derived: false };
  }
  if (summary !== undefined) {
    return { title: summary, derived: false };
  }
  if (firstRequest !== undefined) {
    return { title: firstRequest.slice(0, 200), derived: true };
  }
  return undefined;
}

/** The model with the most turns, else the only/last one, else `unknown`. */
function dominantModel(counts: Map<string, number>): string {
  let best = 'unknown';
  let bestCount = -1;
  for (const [model, count] of counts) {
    if (count > bestCount) {
      best = model;
      bestCount = count;
    }
  }
  return best;
}

function addLoc(stats: SessionTreeStats, loc: WriteLineDelta): void {
  stats.linesOfCode += loc.added.code;
  stats.linesOfDoc += loc.added.doc;
  stats.linesOfCodeRemoved += loc.removed.code;
  stats.linesOfDocRemoved += loc.removed.doc;
}

function addLocToAgent(row: SessionAgentUsage, loc: WriteLineDelta): void {
  row.linesOfCode += loc.added.code;
  row.linesOfDoc += loc.added.doc;
  row.linesOfCodeRemoved += loc.removed.code;
  row.linesOfDocRemoved += loc.removed.doc;
}

/** Parse an ISO timestamp to epoch ms, or 0 when absent/invalid. */
function parseTs(iso: string | undefined): number {
  if (typeof iso !== 'string' || iso.length === 0) {
    return 0;
  }
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Coerce a possibly-undefined token count to a non-negative integer. */
function intOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}
