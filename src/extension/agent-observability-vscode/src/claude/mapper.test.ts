import { describe, it, expect } from 'vitest';
import {
  ClaudeSessionInput,
  buildAggregationRows,
  buildInteractions,
  buildMainTurns,
  buildSessionDetail,
  buildSessionSummary,
} from './mapper';
import { claudeCostMicros } from './pricing';
import { TranscriptRecord } from './transcript';

/** A tiny but realistic session: a prompt → 2 assistant turns (3 tool calls,
 *  one of them a Task spawn) → final response, plus one Explore sub-agent. */
const OPUS = 'claude-opus-4-7';
const HAIKU = 'claude-haiku-4-5';

function mainRecords(): TranscriptRecord[] {
  return [
    { type: 'user', timestamp: '2026-05-01T10:00:00.000Z', cwd: '/repo', message: { role: 'user', content: 'Add a feature' } },
    {
      type: 'assistant',
      timestamp: '2026-05-01T10:00:05.000Z',
      cwd: '/repo',
      message: {
        role: 'assistant',
        model: OPUS,
        usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 },
        stop_reason: 'tool_use',
        content: [
          { type: 'text', text: 'Working on it' },
          { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.ts' } },
          { type: 'tool_use', id: 't2', name: 'Write', input: { file_path: 'a.ts', content: 'l1\nl2\nl3' } },
          { type: 'tool_use', id: 'task1', name: 'Task', input: { description: 'explore' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: '2026-05-01T10:00:09.000Z',
      cwd: '/repo',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', is_error: false },
          { type: 'tool_result', tool_use_id: 't2', is_error: false },
          { type: 'tool_result', tool_use_id: 'task1', is_error: false },
        ],
      },
      toolUseResult: { isAgent: true, agentId: 'agentX', agentType: 'Explore', totalTokens: 999 },
    },
    {
      type: 'assistant',
      timestamp: '2026-05-01T10:00:12.000Z',
      cwd: '/repo',
      message: {
        role: 'assistant',
        model: OPUS,
        usage: { input_tokens: 5, output_tokens: 8 },
        stop_reason: 'end_turn',
        content: [{ type: 'text', text: 'All done' }],
      },
    },
    { type: 'ai-title', aiTitle: 'Add a feature' },
  ];
}

function subagentRecords(): TranscriptRecord[] {
  return [
    {
      type: 'assistant',
      timestamp: '2026-05-01T10:00:07.000Z',
      agentId: 'agentX',
      isSidechain: true,
      message: {
        role: 'assistant',
        model: HAIKU,
        usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 10 },
        stop_reason: 'tool_use',
        content: [{ type: 'tool_use', id: 's1', name: 'Grep', input: { pattern: 'x' } }],
      },
    },
    {
      type: 'user',
      timestamp: '2026-05-01T10:00:08.000Z',
      isSidechain: true,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 's1', is_error: true }] },
    },
  ];
}

function input(): ClaudeSessionInput {
  return {
    sessionId: 'sess-1',
    mainRecords: mainRecords(),
    subagents: [{ agentType: 'Explore', records: subagentRecords() }],
    repository: 'https://github.com/org/repo',
    codeExts: ['.ts'],
    docExts: ['.md'],
  };
}

describe('buildSessionSummary (main thread only)', () => {
  it('counts main-thread LLM calls, tools, tokens, title and source', () => {
    const s = buildSessionSummary(input());
    expect(s.source).toBe('claude');
    expect(s.llmCalls).toBe(2);
    expect(s.toolCalls).toBe(3); // Read, Write, Task — sub-agent's Grep excluded
    expect(s.interactionCount).toBe(5);
    expect(s.inputTokens).toBe(15);
    expect(s.outputTokens).toBe(28);
    expect(s.cachedTokens).toBe(100);
    expect(s.model).toBe(OPUS);
    expect(s.repository).toBe('https://github.com/org/repo');
    expect(s.title).toBe('Add a feature');
    expect(s.titleDerived).toBe(false);
    expect(s.agentModes).toEqual(['agent']);
  });
});

describe('buildSessionDetail (whole tree)', () => {
  it('tree stats include the sub-agent and reconcile cost across rollups', () => {
    const detail = buildSessionDetail(input());
    const t = detail.treeStats;
    expect(t.modelTurns).toBe(3); // 2 main + 1 sub
    expect(t.toolCalls).toBe(4); // 3 main + 1 sub
    expect(t.inputTokens).toBe(18);
    expect(t.outputTokens).toBe(32);
    expect(t.cachedTokens).toBe(110);
    expect(t.totalTokens).toBe(50);
    expect(t.errorCount).toBe(1); // the sub-agent's Grep tool_result is_error
    expect(t.aiuNano).toBe(0);
    expect(t.linesOfCode).toBe(3); // Write wrote 3 lines to a .ts file
    expect(t.linesOfDoc).toBe(0);

    const expectedCost =
      claudeCostMicros(OPUS, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }) +
      claudeCostMicros(OPUS, { input_tokens: 5, output_tokens: 8 }) +
      claudeCostMicros(HAIKU, { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 10 });
    expect(t.costUsdMicros).toBe(expectedCost);

    // Per-model and per-agent rollups sum to the tree cost.
    const modelCost = detail.modelUsage.reduce((a, m) => a + (m.costUsdMicros ?? 0), 0);
    const agentCost = detail.agentUsage.reduce((a, m) => a + (m.costUsdMicros ?? 0), 0);
    expect(modelCost).toBe(expectedCost);
    expect(agentCost).toBe(expectedCost);
  });

  it('separates main vs sub-agent in the per-agent breakdown', () => {
    const detail = buildSessionDetail(input());
    const main = detail.agentUsage.filter((u) => u.kind === 'main');
    const sub = detail.agentUsage.filter((u) => u.kind === 'subagent');
    expect(main).toHaveLength(1);
    expect(main[0].agentName).toBe('Main agent');
    expect(main[0].model).toBe(OPUS);
    expect(sub).toHaveLength(1);
    expect(sub[0].agentName).toBe('Sub-agent: Explore');
    expect(sub[0].model).toBe(HAIKU);
    // Main-first ordering.
    expect(detail.agentUsage[0].kind).toBe('main');
    // One model-turn point per tree LLM call.
    expect(detail.treeModelTurns).toHaveLength(3);
  });
});

describe('buildMainTurns (detail timeline)', () => {
  it('groups into one user-request turn with chat + tool events and a final response', () => {
    const turns = buildMainTurns(mainRecords(), ['.ts'], ['.md']);
    expect(turns).toHaveLength(1);
    const turn = turns[0];
    expect(turn.userRequest).toBe('Add a feature');
    expect(turn.llmCalls).toBe(2);
    expect(turn.finalResponse).toBe('All done');
    expect(turn.linesOfCode).toBe(3);
    // 2 chat events + 3 tool events.
    expect(turn.events.filter((e) => e.operation === 'chat')).toHaveLength(2);
    expect(turn.events.filter((e) => e.operation === 'execute_tool')).toHaveLength(2);
    expect(turn.events.filter((e) => e.operation === 'invoke_agent')).toHaveLength(1);
  });
});

describe('buildAggregationRows (cloud-safe, whole tree)', () => {
  it('emits chat rows with tokens and tool rows with none; Task → invoke_agent', () => {
    const rows = buildAggregationRows(input());
    const chat = rows.filter((r) => r.operation === 'chat');
    const tools = rows.filter((r) => r.operation === 'execute_tool');
    const invoke = rows.filter((r) => r.operation === 'invoke_agent');
    expect(chat).toHaveLength(3); // 2 main + 1 sub
    expect(tools).toHaveLength(3); // Read, Write (main) + Grep (sub)
    expect(invoke).toHaveLength(1); // the Task spawn
    // Tokens live only on chat rows.
    expect(tools.every((r) => r.inputTokens === 0 && r.outputTokens === 0)).toBe(true);
    expect(invoke.every((r) => r.inputTokens === 0)).toBe(true);
    // Every row is agent-mode 'agent', carries the resolved repository + model.
    expect(rows.every((r) => r.agentMode === 'agent')).toBe(true);
    expect(rows.every((r) => r.repository === 'https://github.com/org/repo')).toBe(true);
    expect(chat.some((r) => r.model === OPUS)).toBe(true);
    expect(chat.some((r) => r.model === HAIKU)).toBe(true);
    // The sub-agent's failed tool is statusCode 2.
    expect(tools.some((r) => r.statusCode === 2)).toBe(true);
  });

  it('classifies a Workflow tool call as invoke_agent (this CLI build spawns via Workflow)', () => {
    const records: TranscriptRecord[] = [
      { type: 'user', timestamp: '2026-05-01T10:00:00.000Z', message: { role: 'user', content: 'go' } },
      {
        type: 'assistant',
        timestamp: '2026-05-01T10:00:03.000Z',
        message: {
          role: 'assistant',
          model: OPUS,
          usage: { input_tokens: 1, output_tokens: 1 },
          stop_reason: 'tool_use',
          content: [{ type: 'tool_use', id: 'w1', name: 'Workflow', input: { script: '...' } }],
        },
      },
    ];
    const rows = buildAggregationRows({
      sessionId: 's', mainRecords: records, subagents: [], repository: 'unknown', codeExts: [], docExts: [],
    });
    expect(rows.filter((r) => r.operation === 'invoke_agent')).toHaveLength(1);
    expect(rows.filter((r) => r.operation === 'execute_tool')).toHaveLength(0);
  });
});

describe('buildInteractions (deviation metadata, main thread)', () => {
  it('emits chat + tool interactions with operations and no content', () => {
    const interactions = buildInteractions(input());
    expect(interactions.filter((i) => i.operation === 'chat')).toHaveLength(2);
    expect(interactions.filter((i) => i.operation === 'execute_tool')).toHaveLength(2);
    expect(interactions.filter((i) => i.operation === 'invoke_agent')).toHaveLength(1);
    expect(interactions.every((i) => i.sessionId === 'sess-1' && i.agentMode === 'agent')).toBe(true);
  });
});
