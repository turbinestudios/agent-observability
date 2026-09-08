import { describe, expect, it, vi } from 'vitest';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type { SessionDetail } from '@agent-observability/core/src/telemetry/models';
import {
  buildSessionRetrospective,
  type SessionRetrospective,
} from '@agent-observability/core/src/analysis/retrospective';
import { retrospectiveFor } from './sessionRetrospective';

function detailOf(): SessionDetail {
  return {
    summary: {
      sessionId: 's1',
      repository: 'repo',
      startedAtMs: 0,
      endedAtMs: 0,
      durationMs: 0,
      interactionCount: 0,
      llmCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      model: 'm',
      agentModes: [],
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
  };
}

describe('retrospectiveFor', () => {
  it('passes the loaded detail through to source-specific scoring', () => {
    const detail = detailOf();
    const getSessionRetrospective = vi.fn(() => ({ ok: true as const, value: buildSessionRetrospective(detail) }));
    retrospectiveFor({ getSessionRetrospective } as unknown as SessionDataSource, 's1', detail);
    expect(getSessionRetrospective).toHaveBeenCalledWith('s1', detail);
  });

  it("prefers the source's own retrospective — it can see transcript-only signals", () => {
    const enriched = buildSessionRetrospective(detailOf(), {
      interruptionCount: 2,
      endedWithInterruption: false,
      compactionCount: 0,
      planModeUsed: false,
      apiErrorCount: 0,
      lastEvent: 'assistant-response',
    });
    const source = {
      getSessionRetrospective: (): { ok: true; value: SessionRetrospective } => ({
        ok: true,
        value: enriched,
      }),
    } as unknown as SessionDataSource;

    expect(retrospectiveFor(source, 's1', detailOf()).counts.interruptions).toBe(2);
  });

  it('degrades to the shared turn-level analysis for a source without the method', () => {
    const source = {} as SessionDataSource;
    const retro = retrospectiveFor(source, 's1', detailOf());
    expect(retro.counts.interruptions).toBe(0);
    expect(retro.verdict).toBe('smooth');
  });

  it('falls back the same way when the source method reports a failure', () => {
    const source = {
      getSessionRetrospective: () => ({ ok: false as const, reason: 'error' as const, message: 'nope' }),
    } as unknown as SessionDataSource;
    expect(retrospectiveFor(source, 's1', detailOf()).verdict).toBe('smooth');
  });
});
