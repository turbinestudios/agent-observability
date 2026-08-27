import { describe, it, expect } from 'vitest';
import {
  CLOUD_AGENT_LABEL,
  buildCloudInteractions,
  buildCloudSessionDetail,
  buildCloudSessionSummary,
  buildCloudUserRequestContent,
} from './cloudMapper';
import { CloudSessionInput, ParsedCloudLog, RawCloudSession } from './cloudTypes';

// ---------------------------------------------------------------------------
// Fixtures / inline builders (no disk — mirrors ../claude/mapper.test.ts style).
// ---------------------------------------------------------------------------

const REPO = 'https://github.com/org/repo';
/** CAPI model id carries a producer prefix the mapper must strip. */
const RAW_MODEL = 'sweagent-capi:claude-sonnet-4.6';
const MODEL = 'claude-sonnet-4.6';
/** Raw AI-credit reading (nano-credits) → creditsNano after Math.round. */
const CREDITS = 33570585000;

const CREATED = '2026-07-01T10:00:00.000Z';
const UPDATED = '2026-07-01T10:02:00.000Z';
const COMPLETED = '2026-07-01T10:05:00.000Z';
const CREATED_MS = Date.parse(CREATED);
const UPDATED_MS = Date.parse(UPDATED);
const COMPLETED_MS = Date.parse(COMPLETED);

/** A terminal (`completed`) session with a prompt, model, timestamps and credits. */
function rawSession(overrides: Partial<RawCloudSession> = {}): RawCloudSession {
  return {
    id: 'sess-1',
    name: 'Task name',
    prompt: 'Implement the feature',
    model: RAW_MODEL,
    state: 'completed',
    created_at: CREATED,
    updated_at: UPDATED,
    completed_at: COMPLETED,
    usage: { credits: CREDITS, type: 'ai_credits' },
    ...overrides,
  };
}

/** A parsed CAPI log: 1 setup + 2 real tool calls, a final response, token usage. */
function parsedLog(overrides: Partial<ParsedCloudLog> = {}): ParsedCloudLog {
  return {
    userRequests: ['log-derived request'],
    toolInvocations: [
      { id: 'setup1', name: 'clone-repo', startedAtMs: CREATED_MS + 1000, endedAtMs: CREATED_MS + 2000, durationMs: 1000, success: true, isSetup: true },
      { id: 'call1', name: 'read_file', startedAtMs: CREATED_MS + 3000, endedAtMs: CREATED_MS + 3500, durationMs: 500, success: true, isSetup: false },
      { id: 'call2', name: 'edit_file', startedAtMs: CREATED_MS + 4000, endedAtMs: CREATED_MS + 4700, durationMs: 700, success: false, isSetup: false },
    ],
    finalResponse: 'All done.',
    tokenUsage: { inputTokens: 100, cachedTokens: 400, outputTokens: 50 },
    llmTurns: 3,
    skipped: 0,
    ...overrides,
  };
}

function makeInput(overrides: Partial<CloudSessionInput> = {}): CloudSessionInput {
  return {
    taskId: 'task-1',
    taskName: 'Task name',
    taskState: 'completed',
    session: rawSession(),
    repository: REPO,
    log: undefined,
    nowMs: Date.parse('2026-07-01T11:00:00.000Z'),
    externalUrl: 'https://github.com/org/repo/agents/task-1',
    ...overrides,
  };
}

describe('buildCloudSessionSummary', () => {
  it('strips the model prefix and pins source / agentModes / state / url', () => {
    const s = buildCloudSessionSummary(makeInput());
    expect(s.model).toBe(MODEL);
    expect(s.source).toBe('copilot-cloud');
    expect(s.agentModes).toEqual(['agent']);
    // `completed` warrants no badge.
    expect(s.stateLabel).toBeUndefined();
    expect(s.externalUrl).toBe('https://github.com/org/repo/agents/task-1');
    expect(s.titleDerived).toBe(false);
    expect(s.repository).toBe(REPO);
  });

  it('title = session.name when distinct from the task name, plus the suffix', () => {
    const s = buildCloudSessionSummary(
      makeInput({
        session: rawSession({ name: 'Steer follow-up' }),
        taskName: 'Original task',
        sessionLabelSuffix: ' — session 2/3',
      }),
    );
    expect(s.title).toBe('Steer follow-up — session 2/3');
  });

  it('title falls back to the task name when session.name equals it or is absent', () => {
    const same = buildCloudSessionSummary(
      makeInput({ session: rawSession({ name: 'Original task' }), taskName: 'Original task' }),
    );
    expect(same.title).toBe('Original task');

    const absent = buildCloudSessionSummary(
      makeInput({ session: rawSession({ name: undefined }), taskName: 'Original task' }),
    );
    expect(absent.title).toBe('Original task');
  });

  it('derives a terminal duration from completed_at', () => {
    const s = buildCloudSessionSummary(makeInput());
    expect(s.startedAtMs).toBe(CREATED_MS);
    expect(s.endedAtMs).toBe(COMPLETED_MS);
    expect(s.durationMs).toBe(COMPLETED_MS - CREATED_MS); // 300000
  });

  it('for a non-terminal session ends at max(updated_at, started) and badges the state', () => {
    const s = buildCloudSessionSummary(
      makeInput({
        session: rawSession({ state: 'in_progress', completed_at: undefined }),
        taskState: 'in_progress',
      }),
    );
    expect(s.stateLabel).toBe('in progress');
    expect(s.endedAtMs).toBe(UPDATED_MS);
    expect(s.durationMs).toBe(UPDATED_MS - CREATED_MS); // 120000
  });

  it('reports zero tokens / calls when there is no parsed log', () => {
    const s = buildCloudSessionSummary(makeInput());
    expect(s.inputTokens).toBe(0);
    expect(s.outputTokens).toBe(0);
    expect(s.cachedTokens).toBe(0);
    expect(s.llmCalls).toBe(0);
    expect(s.toolCalls).toBe(0);
    expect(s.interactionCount).toBe(0);
  });

  it('carries the log token usage and non-setup tool count when a log is present', () => {
    const s = buildCloudSessionSummary(makeInput({ log: parsedLog() }));
    expect(s.inputTokens).toBe(100);
    expect(s.outputTokens).toBe(50);
    expect(s.cachedTokens).toBe(400);
    expect(s.llmCalls).toBe(3);
    expect(s.toolCalls).toBe(2); // setup invocation excluded
    expect(s.interactionCount).toBe(5); // 3 llm + 2 tools
  });
});

describe('buildCloudSessionDetail', () => {
  it('builds disjoint tree tokens, credits as the cost basis, and no AIU / USD', () => {
    const detail = buildCloudSessionDetail(makeInput({ log: parsedLog() }));
    const stats = detail.treeStats;
    expect(stats.inputTokens).toBe(100);
    expect(stats.cachedTokens).toBe(400);
    expect(stats.outputTokens).toBe(50);
    // Three disjoint buckets → the genuine total.
    expect(stats.totalTokens).toBe(550);
    expect(stats.modelTurns).toBe(3);
    expect(stats.toolCalls).toBe(2);
    expect(stats.aiuNano).toBe(0);
    expect(stats.costUsdMicros).toBeUndefined();
    expect(stats.creditsNano).toBe(Math.round(CREDITS));
    expect(stats.creditsNano).toBe(33570585000);
    // Legacy `ai_credits` type is already nano-scaled → kept raw, labelled credits.
    expect(stats.creditUnit).toBe('ai_credits');
  });

  it('scales a `pru` (premium request) count into nano and labels the unit', () => {
    const detail = buildCloudSessionDetail(
      makeInput({ session: rawSession({ usage: { credits: 3, type: 'pru' } }), log: parsedLog() }),
    );
    const stats = detail.treeStats;
    // 3 premium requests → 3e9 nano so the shared `creditsNano` contract holds and
    // the value renders as "3" instead of vanishing under a /1e9 division.
    expect(stats.creditsNano).toBe(3_000_000_000);
    expect(stats.creditUnit).toBe('pru');
    // The unit is carried onto the per-agent rollup row for the usage table.
    expect(detail.agentUsage[0].creditsNano).toBe(3_000_000_000);
    expect(detail.agentUsage[0].creditUnit).toBe('pru');
  });

  it('rounds fractional credits and emits rows on credits alone (no log)', () => {
    const detail = buildCloudSessionDetail(
      makeInput({ session: rawSession({ usage: { credits: 1500.6 } }) }),
    );
    expect(detail.treeStats.creditsNano).toBe(1501);
    // No log → zero turns/tokens, yet credits keep the rollup rows alive.
    expect(detail.modelUsage).toHaveLength(1);
    expect(detail.agentUsage).toHaveLength(1);
    expect(detail.modelUsage[0].creditsNano).toBe(1501);
    expect(detail.agentUsage[0].creditsNano).toBe(1501);
  });

  it('emits a single model row and a single main agent row, both carrying creditsNano', () => {
    const detail = buildCloudSessionDetail(makeInput({ log: parsedLog() }));

    expect(detail.modelUsage).toHaveLength(1);
    const m = detail.modelUsage[0];
    expect(m.model).toBe(MODEL);
    expect(m.llmCalls).toBe(3);
    expect(m.aiuNano).toBe(0);
    expect(m.costUsdMicros).toBeUndefined();
    expect(m.creditsNano).toBe(CREDITS);

    expect(detail.agentUsage).toHaveLength(1);
    const a = detail.agentUsage[0];
    expect(a.kind).toBe('main');
    expect(a.agentName).toBe('Copilot cloud agent');
    expect(a.agentName).toBe(CLOUD_AGENT_LABEL);
    expect(a.model).toBe(MODEL);
    expect(a.aiuNano).toBe(0);
    expect(a.costUsdMicros).toBeUndefined();
    expect(a.creditsNano).toBe(CREDITS);
    // The single main row's run time IS the session's run time.
    expect(a.runDurationMs).toBe(detail.summary.durationMs);
  });

  it('builds one turn: REST prompt userRequest, tool events, run_setup tag, final response', () => {
    const detail = buildCloudSessionDetail(makeInput({ log: parsedLog() }));
    expect(detail.turns).toHaveLength(1);
    const turn = detail.turns[0];
    // The REST prompt wins over the log-derived request.
    expect(turn.userRequest).toBe('Implement the feature');
    expect(turn.finalResponse).toBe('All done.');
    expect(turn.llmCalls).toBe(3);

    const exec = turn.events.filter((e) => e.operation === 'execute_tool');
    const setup = turn.events.filter((e) => e.operation === 'run_setup');
    expect(exec).toHaveLength(2);
    expect(setup).toHaveLength(1);
    // Real tool calls, in start order, with per-invocation success carried through.
    expect(exec.map((e) => e.toolName)).toEqual(['read_file', 'edit_file']);
    expect(exec.map((e) => e.success)).toEqual([true, false]);
    expect(setup[0].toolName).toBe('clone-repo');
    // All timeline entries are agent-mode on the resolved model.
    expect(turn.events.every((e) => e.agentMode === 'agent' && e.model === MODEL)).toBe(true);
  });

  it('has an empty treeModelTurns series (no per-turn usage points)', () => {
    const detail = buildCloudSessionDetail(makeInput({ log: parsedLog() }));
    expect(detail.treeModelTurns).toEqual([]);
  });

  it('reconciles: the turn token sums equal the tree stats', () => {
    const detail = buildCloudSessionDetail(makeInput({ log: parsedLog() }));
    const stats = detail.treeStats;
    const sumIn = detail.turns.reduce((acc, t) => acc + t.inputTokens, 0);
    const sumOut = detail.turns.reduce((acc, t) => acc + t.outputTokens, 0);
    const sumCached = detail.turns.reduce((acc, t) => acc + t.cachedTokens, 0);
    expect(sumIn).toBe(stats.inputTokens);
    expect(sumOut).toBe(stats.outputTokens);
    expect(sumCached).toBe(stats.cachedTokens);
  });

  it('a session with no prompt and no log yields no turns and empty rollups', () => {
    const detail = buildCloudSessionDetail(
      makeInput({ session: rawSession({ prompt: undefined, usage: undefined }), log: undefined }),
    );
    expect(detail.turns).toEqual([]);
    expect(detail.modelUsage).toEqual([]);
    expect(detail.agentUsage).toEqual([]);
    // Trivially reconciled: nothing to sum, zeroed tree.
    expect(detail.treeStats.totalTokens).toBe(0);
    expect(detail.treeStats.creditsNano).toBe(0);
  });

  it('still emits a turn when the log has token usage but no prompt/tools/final response', () => {
    // A stream cut off after usage chunks but before any content: tokens exist,
    // but there is no user echo, no tool call, and no stop chunk.
    const detail = buildCloudSessionDetail(
      makeInput({
        session: rawSession({ prompt: undefined, usage: undefined }),
        log: {
          userRequests: [],
          toolInvocations: [],
          finalResponse: undefined,
          tokenUsage: { inputTokens: 100, cachedTokens: 400, outputTokens: 50 },
          llmTurns: 3,
          skipped: 0,
        },
      }),
    );
    expect(detail.turns).toHaveLength(1);
    // Token reconciliation must still hold (the bug: turns [] while tree had 550).
    const sum = detail.turns.reduce((a, t) => a + t.inputTokens + t.cachedTokens + t.outputTokens, 0);
    expect(sum).toBe(detail.treeStats.totalTokens);
    expect(detail.treeStats.totalTokens).toBe(550);
  });

  it('counts a failed / timed_out state as an error even without an error string', () => {
    for (const state of ['failed', 'timed_out'] as const) {
      const detail = buildCloudSessionDetail(
        makeInput({ taskState: state, session: rawSession({ state, error: null, completed_at: COMPLETED }) }),
      );
      expect(detail.treeStats.errorCount).toBe(1);
    }
    // A user-cancelled run is not an error.
    const cancelled = buildCloudSessionDetail(
      makeInput({ taskState: 'cancelled', session: rawSession({ state: 'cancelled', error: null }) }),
    );
    expect(cancelled.treeStats.errorCount).toBe(0);
    // A plain completed run: no error.
    expect(buildCloudSessionDetail(makeInput()).treeStats.errorCount).toBe(0);
  });
});

describe('buildCloudInteractions', () => {
  it('emits one chat + one execute_tool per real tool; tokens only on chat', () => {
    const interactions = buildCloudInteractions(makeInput({ log: parsedLog() }));
    const chat = interactions.filter((i) => i.operation === 'chat');
    const tools = interactions.filter((i) => i.operation === 'execute_tool');
    expect(chat).toHaveLength(1);
    expect(tools).toHaveLength(2); // setup invocation excluded

    expect(chat[0].inputTokens).toBe(100);
    expect(chat[0].outputTokens).toBe(50);
    expect(chat[0].cachedTokens).toBe(400);
    expect(tools.every((i) => i.inputTokens === 0 && i.outputTokens === 0 && i.cachedTokens === 0)).toBe(true);

    // Repository + model propagated to every interaction.
    expect(interactions.every((i) => i.repository === REPO && i.model === MODEL)).toBe(true);
    expect(interactions.every((i) => i.sessionId === 'sess-1' && i.agentMode === 'agent')).toBe(true);
    expect(tools.map((i) => i.toolName)).toEqual(['read_file', 'edit_file']);
  });

  it('emits only the chat interaction when there is no log', () => {
    const interactions = buildCloudInteractions(makeInput());
    expect(interactions).toHaveLength(1);
    expect(interactions[0].operation).toBe('chat');
  });
});

describe('buildCloudUserRequestContent', () => {
  it('keys the session id to the REST prompt when present', () => {
    const content = buildCloudUserRequestContent(makeInput());
    expect(content.size).toBe(1);
    expect(content.get('sess-1')).toBe('Implement the feature');
  });

  it('falls back to the first log user request when there is no prompt', () => {
    const content = buildCloudUserRequestContent(
      makeInput({ session: rawSession({ prompt: undefined }), log: parsedLog() }),
    );
    expect(content.get('sess-1')).toBe('log-derived request');
  });

  it('returns an empty map when there is neither a prompt nor a log request', () => {
    const content = buildCloudUserRequestContent(
      makeInput({ session: rawSession({ prompt: undefined }), log: undefined }),
    );
    expect(content.size).toBe(0);
  });
});
