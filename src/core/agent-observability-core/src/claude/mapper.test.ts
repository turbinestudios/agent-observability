import { describe, it, expect } from 'vitest';
import {
  ClaudeSessionInput,
  buildAggregationRows,
  buildInteractions,
  buildMainTurns,
  buildSessionDetail,
  buildSessionSummary,
  buildUserRequestContent,
} from './mapper';
import { claudeCostMicros } from './pricing';
import { TranscriptRecord } from './transcript';
import { WorkflowDeviationDetector } from '../deviation/deviationDetector';
import { DeviationType, WorkflowConfig } from '../deviation/models';

const REPO = 'https://github.com/org/repo';

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
    // TIN = fresh input incl. cache writes (creation): (10 + 50) + 5 = 65.
    expect(s.inputTokens).toBe(65);
    expect(s.outputTokens).toBe(28);
    // TCI = cache READS only, disjoint from TIN.
    expect(s.cachedTokens).toBe(100);
    expect(s.model).toBe(OPUS);
    expect(s.repository).toBe('https://github.com/org/repo');
    expect(s.title).toBe('Add a feature');
    expect(s.titleDerived).toBe(false);
    expect(s.agentModes).toEqual(['agent']);
  });

  it('prices the main thread with the same per-turn code the detail view sums', () => {
    const s = buildSessionSummary(input());
    // Exactly the two main-thread turns, priced turn by turn — the sub-agent is
    // excluded here just like its tokens are.
    expect(s.costMicros).toBe(
      claudeCostMicros(OPUS, { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 }) +
        claudeCostMicros(OPUS, { input_tokens: 5, output_tokens: 8 }),
    );
  });

  it('reports a session priced by no known model as UNPRICED, not $0', () => {
    const records = mainRecords().map((r) =>
      r.type === 'assistant'
        ? { ...r, message: { ...(r as { message: { model?: string } }).message, model: 'totally-unknown-model' } }
        : r,
    ) as TranscriptRecord[];
    const s = buildSessionSummary({ ...input(), mainRecords: records });
    expect(s.costMicros).toBeUndefined();
  });

  it('reports a session with no LLM turns as a genuine 0', () => {
    const s = buildSessionSummary({
      ...input(),
      mainRecords: [
        { type: 'user', timestamp: '2026-05-01T10:00:00.000Z', cwd: '/repo', message: { role: 'user', content: 'hi' } },
      ],
    });
    expect(s.costMicros).toBe(0);
  });

  it('sums the priceable turns when models are mixed, matching the detail rollup', () => {
    const records = mainRecords();
    // Rewrite ONE assistant turn to an unpriceable model; the other stays Opus.
    const firstAssistant = records.findIndex((r) => r.type === 'assistant');
    const target = records[firstAssistant] as TranscriptRecord & { message: { model?: string } };
    target.message.model = 'totally-unknown-model';

    const s = buildSessionSummary({ ...input(), mainRecords: records });
    // The unknown turn contributes nothing — same as the detail view's rollups.
    expect(s.costMicros).toBe(claudeCostMicros(OPUS, { input_tokens: 5, output_tokens: 8 }));
  });
});

describe('buildSessionDetail (whole tree)', () => {
  it('tree stats include the sub-agent and reconcile cost across rollups', () => {
    const detail = buildSessionDetail(input());
    const t = detail.treeStats;
    expect(t.modelTurns).toBe(3); // 2 main + 1 sub
    expect(t.toolCalls).toBe(4); // 3 main + 1 sub
    // TIN = fresh input incl. cache writes: (10+50) + 5 + 3 = 68.
    expect(t.inputTokens).toBe(68);
    expect(t.outputTokens).toBe(32);
    expect(t.cachedTokens).toBe(110);
    // TT = disjoint buckets' true total: 68 (TIN) + 110 (TCI) + 32 (TOUT) = 210.
    expect(t.totalTokens).toBe(210);
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
    // Wall-clock run time: first observed activity → last. The main thread's
    // first turn starts at its ts minus the gap-derived latency (10:00:05 − 5 s
    // = 10:00:00) and the last turn ends at 10:00:12 → 12 s. The sub-agent's
    // single turn spans its ts (10:00:07) to its tool result (10:00:08) → 1 s.
    expect(main[0].runDurationMs).toBe(12_000);
    expect(sub[0].runDurationMs).toBe(1_000);
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
    // Cloud keeps RAW input_tokens: the 50 cache-CREATION tokens folded into the
    // local TIN display are subtracted back out here, so the org-sync contract is
    // unchanged. Raw chat input = 10 + 5 + 3 = 18 (NOT the display's 68); cache
    // reads pass through as 100 + 0 + 10 = 110.
    expect(chat.reduce((a, r) => a + r.inputTokens, 0)).toBe(18);
    expect(chat.reduce((a, r) => a + r.cachedTokens, 0)).toBe(110);
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

  it('carries a stable span id on chat interactions only (the prompt anchor)', () => {
    const interactions = buildInteractions(input());
    const chats = interactions.filter((i) => i.operation === 'chat');
    expect(chats.every((i) => typeof i.spanId === 'string' && (i.spanId as string).length > 0)).toBe(true);
    // Two turns → two distinct anchors.
    expect(new Set(chats.map((i) => i.spanId)).size).toBe(2);
    // Tool / sub-agent interactions are never user-request anchors.
    expect(interactions.filter((i) => i.operation !== 'chat').every((i) => i.spanId === undefined)).toBe(true);
  });

  it('uses the transcript uuid as the span id when present', () => {
    const recs: TranscriptRecord[] = [
      { type: 'user', timestamp: '2026-05-01T10:00:00.000Z', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant', uuid: 'u-123', timestamp: '2026-05-01T10:00:01.000Z',
        message: { role: 'assistant', model: OPUS, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] },
      },
    ];
    const interactions = buildInteractions({
      sessionId: 's', mainRecords: recs, subagents: [], repository: REPO, codeExts: [], docExts: [],
    });
    expect(interactions.find((i) => i.operation === 'chat')?.spanId).toBe('u-123');
  });
});

describe('buildUserRequestContent (local-only prompt lookup)', () => {
  it('maps each chat span id to the governing user prompt', () => {
    const content = buildUserRequestContent(input());
    const chats = buildInteractions(input()).filter((i) => i.operation === 'chat');
    // Both turns are driven by the single "Add a feature" prompt.
    for (const chat of chats) {
      expect(content.get(chat.spanId as string)).toBe('Add a feature');
    }
  });

  it('lets a content-gated trigger scope a workflow to a Claude slash-command prompt', () => {
    const recs: TranscriptRecord[] = [
      { type: 'user', timestamp: '2026-05-01T10:00:00.000Z', message: { role: 'user', content: '/implement-new-feature add dark mode' } },
      {
        type: 'assistant', timestamp: '2026-05-01T10:00:02.000Z',
        message: { role: 'assistant', model: OPUS, usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: 'end_turn', content: [{ type: 'text', text: 'sure' }] },
      },
    ];
    const claudeInput: ClaudeSessionInput = {
      sessionId: 's2', mainRecords: recs, subagents: [], repository: REPO, codeExts: [], docExts: [],
    };
    const interactions = buildInteractions(claudeInput);
    const content = buildUserRequestContent(claudeInput);
    const lookup = (attribute: string): ReadonlyMap<string, string> =>
      attribute === 'copilot_chat.user_request' ? content : new Map<string, string>();

    // A step that never appears (no `planner`) → the workflow APPLYING is proven by
    // a MissingSteps deviation, which only fires when the content trigger matches.
    const config: WorkflowConfig = {
      repository: REPO,
      workflows: [
        {
          name: 'implement-new-feature',
          expectedSequence: [],
          maxDurationMs: 60 * 60_000,
          sequenceDeviationAlert: true,
          timeoutExceededAlert: false,
          toolUsageAnomalyAlert: false,
          triggerContentPredicate: { attribute: 'copilot_chat.user_request', contains: '/implement-new-feature' },
          steps: [{ name: 'Plan', predicate: { agentName: 'planner' } }],
        },
      ],
    };
    const detector = new WorkflowDeviationDetector();

    const [matched] = detector.detectForTurns([interactions], [config], lookup);
    expect(matched.some((d) => d.type === DeviationType.MissingSteps)).toBe(true);
    expect(matched.every((d) => d.contentDerived === true)).toBe(true);

    // A prompt without the command leaves the workflow inapplicable (fails closed).
    const anchor = interactions.find((i) => i.operation === 'chat')?.spanId as string;
    const otherLookup = (attribute: string): ReadonlyMap<string, string> =>
      attribute === 'copilot_chat.user_request' ? new Map([[anchor, 'just chatting']]) : new Map<string, string>();
    const [unmatched] = detector.detectForTurns([interactions], [config], otherLookup);
    expect(unmatched).toEqual([]);
  });
});
