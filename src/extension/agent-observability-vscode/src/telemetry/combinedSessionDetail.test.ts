import { describe, it, expect } from 'vitest';
import { combineSessionDetails } from './combinedSessionDetail';
import {
  SessionAgentUsage,
  SessionDetail,
  SessionModelUsage,
  agentUsageKey,
} from './models';

/**
 * Tests for {@link combineSessionDetails}: the pure aggregation behind the LOCAL
 * combined-sessions view. Covers summary aggregation, per-model / per-agent
 * merging by key, and the renderer-matching sort order.
 */

function modelUsage(model: string, over: Partial<SessionModelUsage> = {}): SessionModelUsage {
  return {
    model,
    llmCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    aiuNano: 0,
    ...over,
  };
}

function agentUsage(
  agentName: string,
  model: string,
  kind: 'main' | 'subagent',
  over: Partial<SessionAgentUsage> = {},
): SessionAgentUsage {
  return {
    agentName,
    model,
    kind,
    llmCalls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    aiuNano: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    ...over,
  };
}

function session(over: Partial<SessionDetail['summary']>, detail: Partial<SessionDetail> = {}): SessionDetail {
  return {
    summary: {
      sessionId: 'sess',
      repository: 'https://github.com/org/repo',
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      durationMs: 1_000,
      interactionCount: 0,
      llmCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      model: 'gpt-test',
      agentModes: ['agent'],
      ...over,
    },
    treeStats: {
      modelTurns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      aiuNano: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    },
    turns: [],
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
    ...detail,
  };
}

describe('combineSessionDetails', () => {
  it('throws on an empty selection', () => {
    expect(() => combineSessionDetails([])).toThrow();
  });

  it('aggregates summary counters and records distinct repos/models/modes', () => {
    const a = session({
      sessionId: 'a',
      repository: 'https://github.com/org/repo-a',
      startedAtMs: 1_000,
      endedAtMs: 5_000,
      durationMs: 4_000,
      interactionCount: 3,
      llmCalls: 2,
      toolCalls: 1,
      inputTokens: 100,
      outputTokens: 40,
      cachedTokens: 10,
      model: 'gpt-a',
      agentModes: ['agent', 'ask'],
    });
    const b = session({
      sessionId: 'b',
      repository: 'https://github.com/org/repo-b',
      startedAtMs: 3_000,
      endedAtMs: 9_000,
      durationMs: 6_000,
      interactionCount: 5,
      llmCalls: 4,
      toolCalls: 2,
      inputTokens: 200,
      outputTokens: 60,
      cachedTokens: 20,
      model: 'gpt-b',
      agentModes: ['agent'],
    });

    const { summary } = combineSessionDetails([a, b]);

    expect(summary.sessionCount).toBe(2);
    expect(summary.repositories).toEqual([
      'https://github.com/org/repo-a',
      'https://github.com/org/repo-b',
    ]);
    expect(summary.models).toEqual(['gpt-a', 'gpt-b']);
    expect(summary.agentModes).toEqual(['agent', 'ask']);
    expect(summary.startedAtMs).toBe(1_000);
    expect(summary.endedAtMs).toBe(9_000);
    expect(summary.totalDurationMs).toBe(10_000);
    expect(summary.spanMs).toBe(8_000);
    expect(summary.interactionCount).toBe(8);
    expect(summary.llmCalls).toBe(6);
    expect(summary.toolCalls).toBe(3);
    expect(summary.inputTokens).toBe(300);
    expect(summary.outputTokens).toBe(100);
    expect(summary.cachedTokens).toBe(30);
  });

  it('sums each session\'s whole-tree treeStats and re-derives totalTokens', () => {
    const a = session({ sessionId: 'a' }, {
      treeStats: {
        modelTurns: 2, toolCalls: 3, inputTokens: 100, outputTokens: 40,
        cachedTokens: 10, totalTokens: 999, errorCount: 1, aiuNano: 1_000_000_000,
        linesOfCode: 30, linesOfDoc: 10, linesOfCodeRemoved: 5, linesOfDocRemoved: 2,
      },
    });
    const b = session({ sessionId: 'b' }, {
      treeStats: {
        modelTurns: 5, toolCalls: 7, inputTokens: 200, outputTokens: 60,
        cachedTokens: 20, totalTokens: 999, errorCount: 2, aiuNano: 3_000_000_000,
        linesOfCode: 70, linesOfDoc: 25, linesOfCodeRemoved: 9, linesOfDocRemoved: 1,
      },
    });

    const { treeStats } = combineSessionDetails([a, b]);

    expect(treeStats).toEqual({
      modelTurns: 7,
      toolCalls: 10,
      inputTokens: 300,
      outputTokens: 100,
      cachedTokens: 30,
      // Re-derived from merged input + output, NOT the bogus per-session 999s.
      totalTokens: 400,
      errorCount: 3,
      aiuNano: 4_000_000_000,
      linesOfCode: 100,
      linesOfDoc: 35,
      linesOfCodeRemoved: 14,
      linesOfDocRemoved: 3,
    });
  });

  it('merges per-model usage by model and sorts by total tokens desc', () => {
    const a = session({ sessionId: 'a' }, {
      modelUsage: [
        modelUsage('shared', { inputTokens: 10, outputTokens: 5, cachedTokens: 2, llmCalls: 1, reasoningTokens: 1, aiuNano: 1_500_000_000 }),
        modelUsage('small', { inputTokens: 1, outputTokens: 1, llmCalls: 1 }),
      ],
    });
    const b = session({ sessionId: 'b' }, {
      modelUsage: [
        modelUsage('shared', { inputTokens: 20, outputTokens: 5, cachedTokens: 3, llmCalls: 2, reasoningTokens: 4, aiuNano: 2_500_000_000 }),
      ],
    });

    const { modelUsage: merged } = combineSessionDetails([a, b]);

    expect(merged.map((m) => m.model)).toEqual(['shared', 'small']);
    const shared = merged[0];
    expect(shared).toMatchObject({
      llmCalls: 3,
      inputTokens: 30,
      outputTokens: 10,
      cachedTokens: 5,
      reasoningTokens: 5,
      // nano-AIU sums exactly across merged sessions (1.5 + 2.5 = 4 AIU).
      aiuNano: 4_000_000_000,
    });
  });

  it('merges agent usage by (agent, model, kind) and keeps main rows first', () => {
    const a = session({ sessionId: 'a' }, {
      agentUsage: [
        agentUsage('Copilot', 'gpt', 'main', {
          inputTokens: 100,
          llmCalls: 1,
          linesOfCode: 10,
          linesOfDoc: 2,
          linesOfCodeRemoved: 3,
          linesOfDocRemoved: 1,
        }),
        agentUsage('Testing', 'gpt', 'subagent', { inputTokens: 50, llmCalls: 1 }),
      ],
    });
    const b = session({ sessionId: 'b' }, {
      agentUsage: [
        agentUsage('Copilot', 'gpt', 'main', {
          inputTokens: 200,
          llmCalls: 2,
          linesOfCode: 5,
          linesOfDoc: 1,
          linesOfCodeRemoved: 4,
          linesOfDocRemoved: 0,
        }),
      ],
    });

    const { agentUsage: merged } = combineSessionDetails([a, b]);

    // Main rows precede sub-agent rows.
    expect(merged[0].kind).toBe('main');
    expect(merged[merged.length - 1].kind).toBe('subagent');

    const main = merged.find((u) => agentUsageKey(u) === agentUsageKey({ agentName: 'Copilot', model: 'gpt', kind: 'main' }));
    // Tokens AND LoC/LoD sum across the merged sessions.
    expect(main).toMatchObject({
      inputTokens: 300,
      llmCalls: 3,
      linesOfCode: 15,
      linesOfDoc: 3,
      linesOfCodeRemoved: 7,
      linesOfDocRemoved: 1,
    });
  });

  it('does not mutate the input details', () => {
    const a = session({ sessionId: 'a' }, {
      modelUsage: [modelUsage('m', { inputTokens: 10 })],
    });
    combineSessionDetails([a, session({ sessionId: 'b' }, { modelUsage: [modelUsage('m', { inputTokens: 5 })] })]);
    expect(a.modelUsage[0].inputTokens).toBe(10);
  });
});
