import { describe, it, expect } from 'vitest';
import { renderCombinedSessionDetailHtml, CombinedSessionView } from './sessionDetailHtml';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';
import { SessionDetail } from '../telemetry/models';
import { DeviationType, WorkflowDeviation } from '../deviation/models';

/**
 * Rendering tests for the LOCAL combined-sessions webview. Focused on the
 * aggregate header, per-session sections, and XSS-escaping of session titles
 * (which can carry arbitrary local-only text). Single-session section internals
 * are already covered by sessionDetailHtml.test.ts.
 */

const NONCE = 'test-nonce';

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
    },
    turns: [],
    modelUsage: [],
    agentUsage: [],
    ...detail,
  };
}

function viewFor(sessions: SessionDetail[], deviations: readonly WorkflowDeviation[][] = []): CombinedSessionView {
  return {
    combined: combineSessionDetails(sessions),
    sections: sessions.map((detail, i) => ({
      detail,
      deviations: deviations[i] ?? [],
    })),
  };
}

describe('renderCombinedSessionDetailHtml', () => {
  it('renders the aggregate header with the session count and a section per session', () => {
    const a = session({ sessionId: 'aaaa-1111', startedAtMs: 1_000 });
    const b = session({ sessionId: 'bbbb-2222', startedAtMs: 5_000 });

    const html = renderCombinedSessionDetailHtml(viewFor([a, b]), NONCE);

    expect(html).toContain('Combined sessions');
    expect(html).toContain('2 sessions');
    expect(html).toContain('aaaa'); // short id of a
    expect(html).toContain('bbbb'); // short id of b
    // The first section is expanded, later ones collapsed.
    expect(html).toContain('class="turn-request session-section" open');
    // The single-session "Agent run totals" card is NOT part of the combined view.
    expect(html).not.toContain('Agent run totals');
  });

  it('escapes a malicious session title', () => {
    const evil = session({ sessionId: 'x-1', title: '<img src=x onerror=alert(1)>' });
    const html = renderCombinedSessionDetailHtml(viewFor([evil, session({ sessionId: 'y-2' })]), NONCE);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('renders a merged cost & tokens by model table', () => {
    const a = session({ sessionId: 'a-1' }, {
      modelUsage: [
        { model: 'gpt', llmCalls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0, aiuNano: 1_000_000_000 },
      ],
    });
    const b = session({ sessionId: 'b-2' }, {
      modelUsage: [
        { model: 'gpt', llmCalls: 2, inputTokens: 20, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0, aiuNano: 3_000_000_000 },
      ],
    });

    const html = renderCombinedSessionDetailHtml(viewFor([a, b]), NONCE);

    expect(html).toContain('Cost &amp; tokens by model');
    // Merged input tokens 10 + 20 appear in the table.
    expect(html).toContain('>30<');
    // Merged AIU 1 + 3 = 4 appears (formatted to 2 dp).
    expect(html).toContain('4.00');
  });

  it('renders each session\'s own deviations within its section', () => {
    const a = session({ sessionId: 'a-1' });
    const b = session({ sessionId: 'b-2' });
    const deviation: WorkflowDeviation = {
      repository: 'https://github.com/org/repo',
      workflowName: 'wf-a',
      type: DeviationType.MissingSteps,
      description: 'session a deviated',
      detectedAt: 1_000,
    };

    const html = renderCombinedSessionDetailHtml(viewFor([a, b], [[deviation], []]), NONCE);

    expect(html).toContain('session a deviated');
    expect(html).toContain('wf-a');
  });
});
