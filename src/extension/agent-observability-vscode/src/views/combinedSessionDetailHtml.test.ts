import { describe, it, expect } from 'vitest';
import {
  renderCombinedSessionDetailHtml,
  renderCombinedSessionDetailContent,
  CombinedSessionView,
} from './sessionDetailHtml';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';
import { SessionDetail, SessionTurn } from '../telemetry/models';
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

function viewFor(
  sessions: SessionDetail[],
  turnDeviations: readonly (readonly WorkflowDeviation[][])[] = [],
): CombinedSessionView {
  return {
    combined: combineSessionDetails(sessions),
    sections: sessions.map((detail, i) => ({
      detail,
      turnDeviations: turnDeviations[i] ?? [],
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
    // The merged "Agent run totals" card (whole-tree rollup) heads the combined view.
    expect(html).toContain('Agent run totals');
  });

  it('renders a merged "Agent run totals" card summing each session\'s tree stats', () => {
    const a = session({ sessionId: 'a-1' }, {
      treeStats: {
        modelTurns: 2, toolCalls: 3, inputTokens: 100, outputTokens: 40,
        cachedTokens: 10, totalTokens: 140, errorCount: 1, aiuNano: 1_000_000_000,
        linesOfCode: 0, linesOfDoc: 0, linesOfCodeRemoved: 0, linesOfDocRemoved: 0,
      },
    });
    const b = session({ sessionId: 'b-2' }, {
      treeStats: {
        modelTurns: 5, toolCalls: 7, inputTokens: 200, outputTokens: 60,
        cachedTokens: 20, totalTokens: 260, errorCount: 0, aiuNano: 3_000_000_000,
        linesOfCode: 0, linesOfDoc: 0, linesOfCodeRemoved: 0, linesOfDocRemoved: 0,
      },
    });

    const html = renderCombinedSessionDetailHtml(viewFor([a, b]), NONCE);

    expect(html).toContain('Agent run totals');
    // Merged totals: model turns 2+5=7, errors 1+0=1. TT is re-derived over the
    // disjoint buckets: input 300 + cached 30 + output 100 = 430.
    expect(html).toContain('>7<'); // MT
    expect(html).toContain('>430<'); // TT
    // Merged AIU 1 + 3 = 4 AIU.
    expect(html).toContain('4.00');
  });

  it('overlays a scope divider and centered short-id label per session on the trend', () => {
    // One whole-tree model turn → one plotted point; two per session gives each
    // session a scope wide enough to draw a divider and label.
    const mt = (input: number): SessionDetail['treeModelTurns'][number] => ({
      timestampMs: 0,
      model: 'gpt',
      inputTokens: input,
      outputTokens: 1,
      cachedTokens: 0,
      reasoningTokens: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    });
    const a = session({ sessionId: 'aaaa-1111' }, { treeModelTurns: [mt(10), mt(20)] });
    const b = session({ sessionId: 'bbbb-2222' }, { treeModelTurns: [mt(30), mt(40)] });

    const html = renderCombinedSessionDetailHtml(viewFor([a, b]), NONCE);

    // One faint divider between the two sessions' scopes.
    expect(html).toContain('class="trend-session-divider"');
    // A centered label carrying each session's short id sits over its scope.
    expect(html).toMatch(/class="trend-session-label"[^>]*>aaaa</);
    expect(html).toMatch(/class="trend-session-label"[^>]*>bbbb</);
  });

  it('mounts the live shell and keys each session section with a stable data-k', () => {
    const a = session({ sessionId: 'aaaa-1111' });
    const b = session({ sessionId: 'bbbb-2222' });

    const html = renderCombinedSessionDetailHtml(viewFor([a, b]), NONCE);
    expect(html).toContain('<div id="live-root">');

    // The body the panel posts as an `update` carries the per-section keys (and no
    // document shell), so the controller can restore each section's open state.
    const content = renderCombinedSessionDetailContent(viewFor([a, b]));
    expect(content).not.toContain('<!DOCTYPE');
    expect(content).toContain('data-k="s0"');
    expect(content).toContain('data-k="s1"');
  });

  it('escapes a malicious session title', () => {
    const evil = session({ sessionId: 'x-1', title: '<img src=x onerror=alert(1)>' });
    const html = renderCombinedSessionDetailHtml(viewFor([evil, session({ sessionId: 'y-2' })]), NONCE);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('renders a merged "Main agent" token table', () => {
    const a = session({ sessionId: 'a-1' }, {
      agentUsage: [
        { agentName: 'Main agent', model: 'gpt', kind: 'main', llmCalls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0, aiuNano: 1_000_000_000, linesOfCode: 7, linesOfDoc: 1, linesOfCodeRemoved: 2, linesOfDocRemoved: 0 },
      ],
    });
    const b = session({ sessionId: 'b-2' }, {
      agentUsage: [
        { agentName: 'Main agent', model: 'gpt', kind: 'main', llmCalls: 2, inputTokens: 20, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0, aiuNano: 3_000_000_000, linesOfCode: 13, linesOfDoc: 2, linesOfCodeRemoved: 5, linesOfDocRemoved: 1 },
      ],
    });

    const html = renderCombinedSessionDetailHtml(viewFor([a, b]), NONCE);

    expect(html).toContain('<h2>Main agent</h2>');
    // Merged input tokens 10 + 20 appear in the table.
    expect(html).toContain('>30<');
    // Merged AIU 1 + 3 = 4 appears (formatted to 2 dp).
    expect(html).toContain('4.00');
    // The LoC/LoD/nLoC/nLoD columns are present and sum across sessions
    // (LoC 7+13 = 20, LoD 1+2 = 3, nLoC 2+5 = 7, nLoD 0+1 = 1).
    expect(html).toContain('>LoC</th>');
    expect(html).toContain('>nLoD</th>');
    expect(html).toMatch(/<td class="n">20<\/td>\s*<td class="n">3<\/td>\s*<td class="n">7<\/td>\s*<td class="n">1<\/td>/);
  });

  it('renders each session\'s own per-turn deviations within its section', () => {
    const turn: SessionTurn = {
      timestampMs: 1_000,
      agentMode: 'agent',
      model: 'gpt-test',
      durationMs: 10,
      success: true,
      userRequest: 'x',
      llmCalls: 1,
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
    const a = session({ sessionId: 'a-1' }, { turns: [turn] });
    const b = session({ sessionId: 'b-2' });
    const deviation: WorkflowDeviation = {
      repository: 'https://github.com/org/repo',
      workflowName: 'wf-a',
      type: DeviationType.MissingSteps,
      description: 'session a deviated',
      detectedAt: 1_000,
    };

    // Per-session, per-turn: session a's single turn carries the deviation.
    const html = renderCombinedSessionDetailHtml(viewFor([a, b], [[[deviation]], []]), NONCE);

    expect(html).toContain('session a deviated');
    expect(html).toContain('wf-a');
  });
});
