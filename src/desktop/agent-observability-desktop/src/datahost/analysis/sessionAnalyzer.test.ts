import { describe, it, expect } from 'vitest';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type {
  Interaction,
  SessionDetail,
  SessionTurn,
} from '@agent-observability/core/src/telemetry/models';
import type { SessionContextAnalysis } from '@agent-observability/core/src/context/models';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import { analyzeSession } from './sessionAnalyzer';

/**
 * What the background pass records per session. The detection itself is core's
 * and covered there; what matters here is that this app asks for the right
 * thing — the zero-config baseline, scored per turn — and that a session
 * missing half its signals still yields the half it has.
 */

const REPO = 'https://github.com/org/repo';
const SESSION = 'session-1';
const ACCEPTED = { files: [], sources: [] };

function detector(maxSessionMinutes = 60): LocalDeviationDetector {
  return new LocalDeviationDetector({
    getWorkflowConfigs: () => [],
    getMaxSessionMinutes: () => maxSessionMinutes,
  });
}

function turn(timestampMs: number): SessionTurn {
  return {
    timestampMs,
    agentMode: 'agent',
    model: 'model-test',
    durationMs: 1_000,
    success: true,
    llmCalls: 1,
    inputTokens: 10,
    outputTokens: 5,
    cachedTokens: 0,
    reasoningTokens: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    events: [],
  };
}

function detail(turns: SessionTurn[]): SessionDetail {
  return {
    summary: {
      sessionId: SESSION,
      repository: REPO,
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      durationMs: 1_000,
      interactionCount: 1,
      llmCalls: 1,
      toolCalls: 0,
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      model: 'model-test',
      agentModes: ['agent'],
    },
    treeStats: {
      modelTurns: 1,
      toolCalls: 0,
      inputTokens: 10,
      outputTokens: 5,
      cachedTokens: 0,
      totalTokens: 15,
      errorCount: 0,
      aiuNano: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    },
    turns,
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
  };
}

function tool(timestampMs: number, success: boolean): Interaction {
  return {
    timestampMs,
    sessionId: SESSION,
    traceId: SESSION,
    operation: 'execute_tool',
    agentName: 'claude',
    agentMode: 'agent',
    model: 'model-test',
    toolName: 'Edit',
    durationMs: 10,
    success,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    repository: REPO,
  };
}

function contextAnalysis(): SessionContextAnalysis {
  const total = {
    agentName: 'Total',
    kind: 'total' as const,
    loadedFiles: [
      {
        name: 'CLAUDE.md',
        filePath: '/repo/CLAUDE.md',
        category: 'instruction' as const,
        status: 'applied' as const,
        estimatedTokens: 900,
      },
      { name: 'deploy', category: 'skill' as const, status: 'skipped' as const },
    ],
    expectedMissing: [],
    totalContextTokens: 1_000,
    contextFileTokens: 900,
    otherContextTokens: 100,
    oversizedFiles: [],
  };
  return { total, agents: [total] };
}

interface StubOptions {
  detail?: SessionDetail;
  interactions?: Interaction[];
  context?: SessionContextAnalysis;
  /** Make the optional context analysis throw, as a source is allowed to. */
  contextThrows?: boolean;
  /** Refuse the interactions, as an unreadable session would. */
  interactionsFail?: boolean;
}

function stubSource(options: StubOptions = {}): SessionDataSource {
  return {
    id: 'claude',
    label: 'Claude Code',
    costMode: 'usd',
    getSessionDetail: () =>
      options.detail === undefined
        ? { ok: false as const, message: 'gone' }
        : { ok: true as const, value: options.detail },
    getSessionInteractions: () =>
      options.interactionsFail === true
        ? { ok: false as const, message: 'unreadable' }
        : { ok: true as const, value: options.interactions ?? [] },
    getContextAnalysis: () => {
      if (options.contextThrows === true) {
        throw new Error('context analysis blew up');
      }
      return options.context;
    },
  } as unknown as SessionDataSource;
}

function analyze(source: SessionDataSource, maxSessionMinutes = 60) {
  return analyzeSession(source, SESSION, {
    detector: detector(maxSessionMinutes),
    acceptedMissing: ACCEPTED,
  });
}

describe('analyzeSession', () => {
  it('counts the deviations on a mostly-failing turn, with nothing configured', () => {
    const result = analyze(
      stubSource({
        detail: detail([turn(1_000)]),
        interactions: [tool(1_000, false), tool(1_100, false), tool(1_200, true)],
      }),
    );

    expect(result?.deviationCount).toBeGreaterThan(0);
    expect(result?.errorCount).toBe(2);
  });

  it('reports nothing for a healthy session', () => {
    const result = analyze(
      stubSource({
        detail: detail([turn(1_000)]),
        interactions: [tool(1_000, true), tool(1_100, true), tool(1_200, true)],
      }),
    );

    expect(result).toMatchObject({ deviationCount: 0, errorCount: 0, contextFiles: [] });
  });

  it('scores each turn on its own, so a long session is not a long turn', () => {
    const hour = 60 * 60_000;
    const spread = [tool(1_000, true), tool(1_000 + hour, true), tool(1_000 + 2 * hour, true)];

    // As one request the run is two hours and overruns the 60-minute limit...
    expect(
      analyze(stubSource({ detail: detail([turn(1_000)]), interactions: spread }))?.deviationCount,
    ).toBe(1);

    // ...but split across three requests, no single turn does.
    expect(
      analyze(
        stubSource({
          detail: detail([turn(1_000), turn(1_000 + hour), turn(1_000 + 2 * hour)]),
          interactions: spread,
        }),
      )?.deviationCount,
    ).toBe(0);
  });

  it('flattens the context files, keeping how each one got there', () => {
    const files = analyze(
      stubSource({ detail: detail([turn(1_000)]), context: contextAnalysis() }),
    )?.contextFiles;

    expect(files).toEqual([
      {
        name: 'CLAUDE.md',
        filePath: '/repo/CLAUDE.md',
        category: 'instruction',
        status: 'applied',
        estTokens: 900,
      },
      { name: 'deploy', category: 'skill', status: 'skipped', estTokens: 0 },
    ]);
  });

  it('keeps the deviation verdict when the context breakdown fails', () => {
    const result = analyze(
      stubSource({
        detail: detail([turn(1_000)]),
        interactions: [tool(1_000, false), tool(1_100, false), tool(1_200, false)],
        contextThrows: true,
      }),
    );

    expect(result?.deviationCount).toBeGreaterThan(0);
    expect(result?.contextFiles).toEqual([]);
  });

  it('returns nothing at all for a session that can no longer be read', () => {
    expect(analyze(stubSource())).toBeUndefined();
  });

  it('reports no deviations when the interactions cannot be read', () => {
    expect(
      analyze(stubSource({ detail: detail([turn(1_000)]), interactionsFail: true })),
    ).toMatchObject({ deviationCount: 0, errorCount: 0 });
  });
});
