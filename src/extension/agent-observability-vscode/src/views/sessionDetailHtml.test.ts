import { describe, it, expect } from 'vitest';
import { renderSessionDetailHtml, SessionCostView } from './sessionDetailHtml';
import { SessionDetail, SessionTurn } from '../telemetry/models';
import { CostEstimate } from '../telemetry/pricing';
import { DeviationType, WorkflowDeviation } from '../deviation/models';

/**
 * Rendering tests for the local session-detail webview, focused on the Phase 3
 * "local only" badge for content-derived deviations. (XSS-escaping of dynamic
 * values is covered by `escapeHtml.test.ts`.)
 */

const NONCE = 'test-nonce';

const detail: SessionDetail = {
  summary: {
    sessionId: 'abc-123',
    repository: 'https://github.com/org/repo',
    startedAtMs: 1_000_000,
    endedAtMs: 1_060_000,
    durationMs: 60_000,
    interactionCount: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    model: 'gpt-test',
    agentModes: ['agent'],
  },
  turns: [],
  modelUsage: [],
  agentUsage: [],
};

function deviation(overrides: Partial<WorkflowDeviation>): WorkflowDeviation {
  return {
    repository: 'https://github.com/org/repo',
    workflowName: 'wf',
    type: DeviationType.MissingSteps,
    description: 'something happened',
    detectedAt: 1_000_000,
    ...overrides,
  };
}

describe('renderSessionDetailHtml — local-only badge', () => {
  // The `.badge-local` CSS rule is always in the <style> block, so assert on the
  // rendered badge ELEMENT (class attribute + visible text), not the bare class.
  it('renders a "Local only" badge for a content-derived deviation', () => {
    const html = renderSessionDetailHtml(
      detail,
      [deviation({ contentDerived: true, description: "Workflow step 'no-secrets' content condition not met." })],
      NONCE,
    );
    expect(html).toContain('class="badge badge-local"');
    expect(html).toContain('>Local only</span>');
  });

  it('does not render the badge for a metadata-only deviation', () => {
    const html = renderSessionDetailHtml(
      detail,
      [deviation({ type: DeviationType.TimeoutExceeded, description: 'too long' })],
      NONCE,
    );
    expect(html).not.toContain('class="badge badge-local"');
    expect(html).not.toContain('>Local only</span>');
  });

  it('shows the no-deviations panel when there are none', () => {
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).toContain('No deviations detected');
    expect(html).not.toContain('class="badge badge-local"');
  });

  it('omits the cost section and header row when there are no model-usage rows', () => {
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).not.toContain('Cost &amp; tokens by model');
    expect(html).not.toContain('Estimated cost');
  });
});

describe('renderSessionDetailHtml — cost & tokens by model', () => {
  /**
   * Three models exercising every cost outcome in one render:
   * - `claude-opus-4-6`: priced, non-zero tokens → `$0.0234 (est.)`;
   * - `gpt-zero`: a KNOWN rate applied to ZERO tokens → a legitimate `$0.0000 (est.)`;
   * - `<script>evil</script>`: unpriced (and XSS-laden) → `n/a` (never `$0`).
   */
  const usageDetail: SessionDetail = {
    summary: {
      ...detail.summary,
      llmCalls: 3,
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 100,
    },
    turns: [],
    modelUsage: [
      {
        model: 'claude-opus-4-6',
        llmCalls: 2,
        inputTokens: 800,
        outputTokens: 150,
        cachedTokens: 100,
        reasoningTokens: 0,
      },
      {
        model: 'gpt-zero',
        llmCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
      },
      {
        model: '<script>evil</script>',
        llmCalls: 1,
        inputTokens: 200,
        outputTokens: 50,
        cachedTokens: 0,
        reasoningTokens: 0,
      },
    ],
    agentUsage: [],
  };

  /** Two models priced (one a legitimate $0), one not → the session total is partial. */
  const cost: SessionCostView = {
    costByModel: new Map<string, CostEstimate>([
      ['claude-opus-4-6', { available: true, inputUsd: 0.012, outputUsd: 0.011, totalUsd: 0.0234 }],
      ['gpt-zero', { available: true, inputUsd: 0, outputUsd: 0, totalUsd: 0 }],
      ['<script>evil</script>', { available: false }],
    ]),
    total: { available: true, totalUsd: 0.0234, partial: true },
  };

  /** Extract the rendered `<tfoot>` Total row so footer cells can be asserted in isolation. */
  function footerRow(html: string): string {
    return html.match(/<td class="model">Total<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
  }

  it('renders the table heading, the header Estimated-cost row, and the est.-labelled cost', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE, cost);
    expect(html).toContain('Cost &amp; tokens by model');
    // The header Estimated-cost row reflects the passed-in session total (partial).
    expect(html).toContain('<dt>Estimated cost</dt><dd>$0.0234 (est.) + n/a</dd>');
    // The priced model shows a labelled estimate; the `(est.)` label is mandatory.
    expect(html).toContain('$0.0234 (est.)');
  });

  it('renders a legitimate $0 for a KNOWN rate with zero tokens (not n/a)', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE, cost);
    // A configured rate applied to zero tokens is a real $0 estimate — not n/a.
    expect(html).toContain('$0.0000 (est.)');
  });

  it("renders n/a (never $0) in the unpriced model's own cost cell", () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE, cost);
    // Row-scoped: this exact cell appears only for the unpriced model — the partial
    // total embeds `+ n/a` in a larger string and the priced cells are `$…`.
    expect(html).toContain('<td class="n">n/a</td>');
    // The escaped unpriced model id and its n/a cost cell are in the same row.
    expect(html).toMatch(
      /&lt;script&gt;evil&lt;\/script&gt;<\/td>[\s\S]*?<td class="n">n\/a<\/td>[\s\S]*?<\/tr>/,
    );
  });

  it('renders a footer Total row that sums the per-model token columns and cost', () => {
    const footer = footerRow(renderSessionDetailHtml(usageDetail, [], NONCE, cost));
    expect(footer).toContain('<td class="n">4</td>'); // llmCalls 2 + 1 + 1
    expect(footer).toContain('<td class="n">1000</td>'); // input 800 + 0 + 200
    expect(footer).toContain('<td class="n">200</td>'); // output 150 + 0 + 50
    expect(footer).toContain('<td class="n">100</td>'); // cached 100 + 0 + 0
    // Footer total matches the header rollup, partial marker included.
    expect(footer).toContain('$0.0234 (est.) + n/a');
  });

  it('escapes a model id containing markup', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE, cost);
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;');
    expect(html).not.toContain('<script>evil</script>');
  });

  it('renders without throwing on the 3-arg call (no cost data) — all costs n/a', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE);
    expect(html).toContain('Cost &amp; tokens by model');
    expect(html).toContain('<td class="n">n/a</td>');
    // With no rates supplied there is no estimate to label anywhere.
    expect(html).not.toContain('(est.)');
    // The footer total is likewise unavailable.
    expect(footerRow(html)).toContain('<td class="n">n/a</td>');
  });
});

describe('renderSessionDetailHtml — spawned sub-agents', () => {
  /** Main thread + two spawned sub-agents on different models. */
  const agentDetail: SessionDetail = {
    summary: {
      ...detail.summary,
      llmCalls: 3,
      inputTokens: 5000,
      outputTokens: 200,
      cachedTokens: 100,
    },
    turns: [],
    modelUsage: [
      { model: 'gpt-5.4', llmCalls: 3, inputTokens: 5000, outputTokens: 200, cachedTokens: 100, reasoningTokens: 0 },
    ],
    agentUsage: [
      { agentName: 'GitHub Copilot Chat', model: 'gpt-5.4', kind: 'main', llmCalls: 3, inputTokens: 5000, outputTokens: 200, cachedTokens: 100, reasoningTokens: 0 },
      { agentName: 'Testing', model: 'gpt-5.3-codex', kind: 'subagent', llmCalls: 2, inputTokens: 1300, outputTokens: 40, cachedTokens: 0, reasoningTokens: 0 },
      { agentName: 'Frontend', model: 'gpt-5.4', kind: 'subagent', llmCalls: 1, inputTokens: 900, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0 },
    ],
  };

  it('renders the main agent in the header and a Spawned sub-agents section', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    expect(html).toContain('<dt>Agent</dt><dd>GitHub Copilot Chat</dd>');
    expect(html).toContain('Spawned sub-agents');
    // Each spawned sub-agent appears with its name and model.
    expect(html).toContain('<td>Testing</td>');
    expect(html).toContain('<td>Frontend</td>');
    expect(html).toContain('gpt-5.3-codex');
  });

  it('sub-agent subtotal sums only the sub-agent rows (excludes the main thread)', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    const sub = html.match(/<td>Sub-agent total<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(sub).toContain('<td class="n">3</td>'); // calls 2 + 1
    expect(sub).toContain('<td class="n">2200</td>'); // input 1300 + 900
    expect(sub).toContain('<td class="n">50</td>'); // output 40 + 10
  });

  it('omits the section entirely when there are no spawned sub-agents', () => {
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).not.toContain('Spawned sub-agents');
  });

  it('does not let sub-agents inflate the session header totals', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    // The header Tokens row reflects the main-thread totals only (5000 in / 200 out).
    expect(html).toContain('5000 / 200 (cached 100)');
  });
});

describe('renderSessionDetailHtml — grouped turns', () => {
  const turn: SessionTurn = {
    timestampMs: 1_700_000_000_000,
    agentMode: 'agent',
    model: 'gpt-test',
    durationMs: 4321,
    success: true,
    userRequest: 'Refactor the parser',
    finalResponse: 'Done — refactored into three modules.',
    llmCalls: 2,
    inputTokens: 1234,
    outputTokens: 340,
    cachedTokens: 100,
    reasoningTokens: 0,
    events: [
      {
        timestampMs: 1_700_000_001_000,
        operation: 'execute_tool',
        agentMode: 'agent',
        model: 'gpt-test',
        toolName: 'read_file',
        durationMs: 12,
        success: true,
      },
    ],
  };
  const turnDetail: SessionDetail = { ...detail, turns: [turn] };

  it('renders a User Request disclosure nesting the event timeline', () => {
    const html = renderSessionDetailHtml(turnDetail, [], NONCE);
    expect(html).toContain('1 turn(s)');
    expect(html).toContain('User request');
    expect(html).toContain('Refactor the parser');
    // The event timeline is nested under the request, as a second-level disclosure.
    expect(html).toContain('Timeline (1 event(s))');
    expect(html).toContain('read_file');
  });

  it('renders a Final LLM response disclosure with the response text', () => {
    const html = renderSessionDetailHtml(turnDetail, [], NONCE);
    expect(html).toContain('Final LLM response');
    expect(html).toContain('Done — refactored into three modules.');
  });

  it('renders the per-turn token badge (input ↑ / output ↓)', () => {
    const html = renderSessionDetailHtml(turnDetail, [], NONCE);
    expect(html).toContain('↑ 1234 ↓ 340');
  });

  it('keeps every disclosure collapsed by default (no open attribute)', () => {
    const html = renderSessionDetailHtml(turnDetail, [], NONCE);
    expect(html).not.toMatch(/<details[^>]*\sopen[\s>]/);
  });

  it('labels a request-less synthetic turn as activity and omits the response block', () => {
    const synthetic: SessionTurn = {
      timestampMs: 1_700_000_000_000,
      agentMode: 'agent',
      model: 'gpt-test',
      durationMs: 0,
      success: true,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      reasoningTokens: 0,
      events: [turn.events[0]],
    };
    const html = renderSessionDetailHtml({ ...detail, turns: [synthetic] }, [], NONCE);
    expect(html).toContain('Activity (no user request)');
    expect(html).not.toContain('Final LLM response');
    // A turn with no main-thread LLM call shows no token badge.
    expect(html).not.toContain('class="turn-tokens"');
  });
});
