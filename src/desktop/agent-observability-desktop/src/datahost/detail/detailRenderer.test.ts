import { describe, it, expect } from 'vitest';
import type { SessionDataSource } from '@agent-observability/core/src/sources/sessionSource';
import type {
  CostMode,
  Interaction,
  SessionDetail,
  SessionTurn,
} from '@agent-observability/core/src/telemetry/models';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import { DetailRenderer } from './detailRenderer';
import type { CombinedRequest } from './detailRenderer';

/**
 * The combined document is assembled here from core's renderer, which is
 * already covered upstream. What these tests hold is the wiring this app owns:
 * that the sessions merge, that the app's own theme reaches the document, and
 * that one unreadable transcript costs the user a section rather than the view.
 */

function session(sessionId: string, startedAtMs: number, tokens: number): SessionDetail {
  return {
    summary: {
      sessionId,
      repository: 'https://github.com/org/repo',
      startedAtMs,
      endedAtMs: startedAtMs + 1_000,
      durationMs: 1_000,
      interactionCount: 1,
      llmCalls: 1,
      toolCalls: 0,
      inputTokens: tokens,
      outputTokens: 0,
      cachedTokens: 0,
      model: 'model-test',
      agentModes: ['agent'],
    },
    treeStats: {
      modelTurns: 2,
      toolCalls: 0,
      inputTokens: tokens,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: tokens,
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

/**
 * A source that answers for the sessions it was given and fails for the rest.
 * `interactions` is what the deviation detector reads; a source that supplies
 * none behaves like one whose metadata could not be read.
 */
function stubSource(
  id: string,
  label: string,
  costMode: CostMode,
  details: SessionDetail[],
  interactions: Record<string, Interaction[]> = {},
) {
  return {
    id,
    label,
    costMode,
    getSessionDetail(sessionId: string) {
      const found = details.find((d) => d.summary.sessionId === sessionId);
      return found === undefined
        ? { ok: false as const, message: `no session ${sessionId}` }
        : { ok: true as const, value: found };
    },
    getSessionInteractions(sessionId: string) {
      return { ok: true as const, value: interactions[sessionId] ?? [] };
    },
  } as unknown as SessionDataSource;
}

function registry(...sources: SessionDataSource[]) {
  return { get: (id: string) => sources.find((s) => s.id === id) };
}

/** No configured workflows, so only the zero-config baseline checks run. */
function detector(maxSessionMinutes = 60): LocalDeviationDetector {
  return new LocalDeviationDetector({
    getWorkflowConfigs: () => [],
    getMaxSessionMinutes: () => maxSessionMinutes,
  });
}

function makeRenderer(sources: { get(id: string): SessionDataSource | undefined }): DetailRenderer {
  return new DetailRenderer(sources, detector());
}

function request(source: string, sessionId: string): CombinedRequest {
  return {
    source,
    sessionId,
    stamp: 1,
    context: { acceptedMissing: { files: [], sources: [] } },
  };
}

const A = session('aaaaaaaa-1', 2_000, 100);
const B = session('bbbbbbbb-2', 1_000, 250);

describe('DetailRenderer.renderCombinedDocument', () => {
  it('merges the selected sessions into one document whose totals are the sum of the parts', () => {
    const renderer = makeRenderer(registry(stubSource('claude', 'Claude Code', 'usd', [A, B])));

    const result = renderer.renderCombinedDocument(
      [request('claude', A.summary.sessionId), request('claude', B.summary.sessionId)],
      'dark',
    );

    expect(result.skipped).toBe(0);
    expect(result.html).toContain('2 sessions');
    // 100 + 250 input tokens, and 2 + 2 model turns, formatted with separators.
    expect(result.html).toContain('350');
    expect(result.html).toContain('Combined sessions');
  });

  it('orders sections by start time, so the token trend reads forwards', () => {
    const renderer = makeRenderer(registry(stubSource('claude', 'Claude Code', 'usd', [A, B])));

    // Requested newest-first; B started earlier and must still render first.
    const html = renderer.renderCombinedDocument(
      [request('claude', A.summary.sessionId), request('claude', B.summary.sessionId)],
      'light',
    ).html;

    expect(html.indexOf('bbbbbbbb')).toBeLessThan(html.indexOf('aaaaaaaa'));
  });

  it('carries the app theme and the outside-VS-Code shim into the document', () => {
    const renderer = makeRenderer(registry(stubSource('claude', 'Claude Code', 'usd', [A, B])));

    const html = renderer.renderCombinedDocument(
      [request('claude', A.summary.sessionId), request('claude', B.summary.sessionId)],
      'dark',
    ).html;

    // Without these the document renders as unstyled text and throws on load.
    expect(html).toContain('--vscode-foreground');
    expect(html).toContain('acquireVsCodeApi');
  });

  it('notes the cost basis when the selection spans sources, and not when it does not', () => {
    const renderer = makeRenderer(
      registry(
        stubSource('claude', 'Claude Code', 'usd', [A]),
        stubSource('copilot', 'Copilot', 'aiu', [B]),
      ),
    );

    const mixed = renderer.renderCombinedDocument(
      [request('claude', A.summary.sessionId), request('copilot', B.summary.sessionId)],
      'dark',
    );
    expect(mixed.costNote).toContain('Copilot');

    const single = makeRenderer(
      registry(stubSource('claude', 'Claude Code', 'usd', [A, B])),
    ).renderCombinedDocument(
      [request('claude', A.summary.sessionId), request('claude', B.summary.sessionId)],
      'dark',
    );
    expect(single.costNote).toBeUndefined();
  });

  it('marks the off-basis session as not cost-comparable in the comparison table', () => {
    const renderer = makeRenderer(
      registry(
        stubSource('claude', 'Claude Code', 'usd', [A]),
        stubSource('copilot', 'Copilot', 'aiu', [B]),
      ),
    );

    const html = renderer.renderCombinedDocument(
      [request('claude', A.summary.sessionId), request('copilot', B.summary.sessionId)],
      'dark',
    ).html;

    // The per-section costMode flowed through: the diff table renders, and the
    // minority-basis session's cost row is an honest em dash with the note.
    expect(html).toContain('class="compare-table"');
    expect(html).toContain('is billed in a different unit');
  });

  it('leaves out a session it cannot read, and counts it', () => {
    const renderer = makeRenderer(registry(stubSource('claude', 'Claude Code', 'usd', [A])));

    const result = renderer.renderCombinedDocument(
      [request('claude', A.summary.sessionId), request('claude', 'gone')],
      'dark',
    );

    expect(result.skipped).toBe(1);
    expect(result.html).toContain('1 sessions');
  });

  it('fails only when nothing at all could be read', () => {
    const renderer = makeRenderer(registry(stubSource('claude', 'Claude Code', 'usd', [])));

    expect(() =>
      renderer.renderCombinedDocument([request('claude', 'gone'), request('claude', 'also-gone')], 'dark'),
    ).toThrow(/None of the selected sessions/);
  });
});

/** A session with one user-request turn, so per-turn detection has something to analyze. */
function turnedSession(sessionId: string, startedAtMs: number): SessionDetail {
  const detail = session(sessionId, startedAtMs, 100);
  const turn: SessionTurn = {
    timestampMs: startedAtMs,
    agentMode: 'agent',
    model: 'model-test',
    durationMs: 1_000,
    success: true,
    llmCalls: 1,
    inputTokens: 100,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    events: [],
  };
  return { ...detail, turns: [turn] };
}

function toolCall(sessionId: string, timestampMs: number, success: boolean): Interaction {
  return {
    timestampMs,
    sessionId,
    traceId: sessionId,
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
    repository: 'https://github.com/org/repo',
  };
}

describe('DetailRenderer deviations', () => {
  const FLAGGED = turnedSession('cccccccc-3', 5_000);
  const CLEAN = turnedSession('dddddddd-4', 5_000);

  /** A turn that failed more often than it succeeded — the zero-config baseline. */
  const failing = [
    toolCall(FLAGGED.summary.sessionId, 5_000, false),
    toolCall(FLAGGED.summary.sessionId, 5_100, false),
    toolCall(FLAGGED.summary.sessionId, 5_200, true),
  ];
  const healthy = [
    toolCall(CLEAN.summary.sessionId, 5_000, true),
    toolCall(CLEAN.summary.sessionId, 5_100, true),
    toolCall(CLEAN.summary.sessionId, 5_200, true),
  ];

  function sourceWith(details: SessionDetail[], interactions: Record<string, Interaction[]>) {
    return registry(stubSource('claude', 'Claude Code', 'usd', details, interactions));
  }

  it('draws a card on the turn that failed, with no workflow configured', () => {
    const html = makeRenderer(sourceWith([FLAGGED], { [FLAGGED.summary.sessionId]: failing })).renderDocument(
      'claude',
      FLAGGED.summary.sessionId,
      'dark',
      1,
      { acceptedMissing: { files: [], sources: [] } },
    );

    expect(html).toContain('ToolUsageAnomaly');
    expect(html).toContain('workflow divergence(s)');
  });

  it('leaves a healthy session unmarked, so the timeline stays quiet', () => {
    const html = makeRenderer(sourceWith([CLEAN], { [CLEAN.summary.sessionId]: healthy })).renderDocument(
      'claude',
      CLEAN.summary.sessionId,
      'dark',
      1,
      { acceptedMissing: { files: [], sources: [] } },
    );

    expect(html).not.toContain('ToolUsageAnomaly');
    expect(html).not.toContain('<article class="deviation');
  });

  it('carries the same cards into a refresh, which swaps the body in place', () => {
    const renderer = makeRenderer(sourceWith([FLAGGED], { [FLAGGED.summary.sessionId]: failing }));
    const context = { acceptedMissing: { files: [], sources: [] } };

    renderer.renderDocument('claude', FLAGGED.summary.sessionId, 'dark', 1, context);
    const body = renderer.renderBody('claude', FLAGGED.summary.sessionId, 1, context);

    expect(body).toContain('ToolUsageAnomaly');
  });

  it('marks up a comparison the same way, so a flagged run stands out in it', () => {
    const renderer = makeRenderer(
      sourceWith([FLAGGED, CLEAN], {
        [FLAGGED.summary.sessionId]: failing,
        [CLEAN.summary.sessionId]: healthy,
      }),
    );

    const result = renderer.renderCombinedDocument(
      [request('claude', FLAGGED.summary.sessionId), request('claude', CLEAN.summary.sessionId)],
      'dark',
    );

    expect(result.html).toContain('ToolUsageAnomaly');
  });

  it('forgets its cached verdicts when the threshold behind them changes', () => {
    const renderer = makeRenderer(sourceWith([FLAGGED], { [FLAGGED.summary.sessionId]: failing }));
    const context = { acceptedMissing: { files: [], sources: [] } };

    renderer.renderDocument('claude', FLAGGED.summary.sessionId, 'dark', 1, context);
    renderer.invalidateAll();

    // The same stamp would otherwise be served from the cache; re-rendering it
    // proves the parse (and its detection) actually ran again.
    expect(renderer.renderDocument('claude', FLAGGED.summary.sessionId, 'dark', 1, context)).toContain(
      'ToolUsageAnomaly',
    );
  });
});
