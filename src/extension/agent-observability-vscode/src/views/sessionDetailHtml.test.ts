import { describe, it, expect } from 'vitest';
import { renderSessionDetailHtml, SessionCostView } from './sessionDetailHtml';
import { SessionDetail, SessionTreeStats, SessionTurn, agentUsageKey } from '../telemetry/models';
import { CostEstimate } from '../telemetry/pricing';
import { DeviationType, WorkflowDeviation } from '../deviation/models';

/**
 * Rendering tests for the local session-detail webview, focused on the Phase 3
 * "local only" badge for content-derived deviations. (XSS-escaping of dynamic
 * values is covered by `escapeHtml.test.ts`.)
 */

const NONCE = 'test-nonce';

/** Zeroed agent-tree rollup for fixtures that don't exercise the summary card. */
const ZERO_TREE_STATS: SessionTreeStats = {
  modelTurns: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  totalTokens: 0,
  errorCount: 0,
  aiuNano: 0,
};

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
  treeStats: ZERO_TREE_STATS,
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

  it('omits the main-agent section when there are no agent-usage rows', () => {
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).not.toContain('<h2>Main agent</h2>');
    expect(html).not.toContain('Estimated cost');
  });

  it('keeps the header to start / end / duration only', () => {
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).toContain('<dt>Started</dt>');
    expect(html).toContain('<dt>Ended</dt>');
    expect(html).toContain('<dt>Duration</dt>');
    // The richer per-thread fields have moved out of the header.
    expect(html).not.toContain('<dt>Repository</dt>');
    expect(html).not.toContain('<dt>Interactions</dt>');
    expect(html).not.toContain('<dt>Tokens in / out</dt>');
  });
});

describe('renderSessionDetailHtml — Main agent cost & tokens', () => {
  /**
   * The Main agent table is driven by `agentUsage` (kind `main`) and priced via
   * `costByAgent`. Three models on the main thread exercise every cost outcome:
   * - `claude-opus-4-6`: priced, non-zero tokens → `$0.0234 (est.)`;
   * - `gpt-zero`: a KNOWN rate applied to ZERO tokens → a legitimate `$0.0000 (est.)`;
   * - `<script>evil</script>`: unpriced (and XSS-laden) → `n/a` (never `$0`).
   */
  const main = (
    model: string,
    over: Partial<SessionDetail['agentUsage'][number]>,
  ): SessionDetail['agentUsage'][number] => ({
    agentName: 'Main agent',
    model,
    kind: 'main',
    llmCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    aiuNano: 0,
    ...over,
  });

  const usageDetail: SessionDetail = {
    summary: {
      ...detail.summary,
      llmCalls: 3,
      inputTokens: 1000,
      outputTokens: 200,
      cachedTokens: 100,
    },
    treeStats: ZERO_TREE_STATS,
    turns: [],
    modelUsage: [],
    agentUsage: [
      main('claude-opus-4-6', { llmCalls: 2, inputTokens: 800, outputTokens: 150, cachedTokens: 100, aiuNano: 2_042_500_000 }),
      main('gpt-zero', { llmCalls: 1 }),
      main('<script>evil</script>', { llmCalls: 1, inputTokens: 200, outputTokens: 50, aiuNano: 500_000_000 }),
    ],
  };

  /** Two models priced (one a legitimate $0), one not → the subtotal is partial. */
  const cost: SessionCostView = {
    costByModel: new Map<string, CostEstimate>(),
    costByAgent: new Map<string, CostEstimate>([
      [agentUsageKey({ agentName: 'Main agent', model: 'claude-opus-4-6', kind: 'main' }), { available: true, inputUsd: 0.012, outputUsd: 0.011, totalUsd: 0.0234 }],
      [agentUsageKey({ agentName: 'Main agent', model: 'gpt-zero', kind: 'main' }), { available: true, inputUsd: 0, outputUsd: 0, totalUsd: 0 }],
      [agentUsageKey({ agentName: 'Main agent', model: '<script>evil</script>', kind: 'main' }), { available: false }],
    ]),
    total: { available: true, totalUsd: 0.0234, partial: true },
  };

  /** Extract the rendered `<tfoot>` Total row so footer cells can be asserted in isolation. */
  function footerRow(html: string): string {
    return html.match(/<td>Total<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
  }

  it('renders the "Main agent" heading and the est.-labelled cost in the footer total', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE, cost);
    expect(html).toContain('<h2>Main agent</h2>');
    // The priced model shows a labelled estimate; the `(est.)` label is mandatory.
    expect(html).toContain('$0.0234 (est.)');
    // The footer Total reflects the main-agent subtotal (partial).
    expect(footerRow(html)).toContain('$0.0234 (est.) + n/a');
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

  it('renders a footer Total row that sums the per-row token columns and cost', () => {
    const footer = footerRow(renderSessionDetailHtml(usageDetail, [], NONCE, cost));
    expect(footer).toContain('<td class="n">4</td>'); // llmCalls 2 + 1 + 1
    expect(footer).toContain('<td class="n">1000</td>'); // input 800 + 0 + 200
    expect(footer).toContain('<td class="n">200</td>'); // output 150 + 0 + 50
    expect(footer).toContain('<td class="n">100</td>'); // cached 100 + 0 + 0
    // Footer total sums the main-agent rows, partial marker included.
    expect(footer).toContain('$0.0234 (est.) + n/a');
  });

  it('escapes a model id containing markup', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE, cost);
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;');
    expect(html).not.toContain('<script>evil</script>');
  });

  it('renders without throwing on the 3-arg call (no cost data) — all costs n/a', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE);
    expect(html).toContain('<h2>Main agent</h2>');
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
    treeStats: ZERO_TREE_STATS,
    turns: [],
    modelUsage: [
      { model: 'gpt-5.4', llmCalls: 3, inputTokens: 5000, outputTokens: 200, cachedTokens: 100, reasoningTokens: 0, aiuNano: 3_000_000_000 },
    ],
    agentUsage: [
      { agentName: 'GitHub Copilot Chat', model: 'gpt-5.4', kind: 'main', llmCalls: 3, inputTokens: 5000, outputTokens: 200, cachedTokens: 100, reasoningTokens: 0, aiuNano: 3_000_000_000 },
      { agentName: 'Testing', model: 'gpt-5.3-codex', kind: 'subagent', llmCalls: 2, inputTokens: 1300, outputTokens: 40, cachedTokens: 0, reasoningTokens: 0, aiuNano: 0 },
      { agentName: 'Frontend', model: 'gpt-5.4', kind: 'subagent', llmCalls: 1, inputTokens: 900, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0, aiuNano: 0 },
    ],
  };

  it('renders the Main agent table and a Spawned sub-agents section', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    expect(html).toContain('<h2>Main agent</h2>');
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

  it('does not let sub-agents inflate the main-agent totals', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    // The "Main agent" footer reflects main-thread tokens only (5000 in), not the
    // 7200 it would show if the 1300 + 900 sub-agent inputs were folded in.
    const mainFooter = html.match(/<td>Total<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(mainFooter).toContain('<td class="n">5000</td>');
    expect(mainFooter).not.toContain('<td class="n">7200</td>');
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

describe('renderSessionDetailHtml — Agent run totals card', () => {
  // The verified c1eb060a Agent Debug Logs numbers (whole agent tree, incl. sub-agents).
  const treeDetail: SessionDetail = {
    ...detail,
    treeStats: {
      modelTurns: 183,
      toolCalls: 289,
      inputTokens: 9_042_804,
      outputTokens: 85_089,
      cachedTokens: 8_562_370,
      totalTokens: 9_127_893,
      errorCount: 1,
      aiuNano: 536_264_925_000,
    },
  };

  it('renders all eight totals as an acronym flat list with the agent-tree values', () => {
    const html = renderSessionDetailHtml(treeDetail, [], NONCE);
    expect(html).toContain('Agent run totals');
    expect(html).toContain('incl. spawned sub-agents');
    // Acronym labels, with the full name preserved in the title for discoverability.
    for (const [acr, label] of [
      ['MT', 'Model Turns'],
      ['TC', 'Tool Calls'],
      ['TIN', 'Total Input Tokens'],
      ['TOUT', 'Total Output Tokens'],
      ['TCI', 'Total Cached Input Tokens'],
      ['TT', 'Total Tokens'],
      ['ERR', 'Errors'],
      ['AIU', 'Copilot Usage (AIU)'],
    ]) {
      expect(html).toContain(`title="${label}">${acr}</dt>`);
    }
    // Values with thousands separators, matching GitHub's Agent Debug Logs.
    expect(html).toContain('<dd>183</dd>');
    expect(html).toContain('<dd>289</dd>');
    expect(html).toContain('<dd>9,042,804</dd>');
    expect(html).toContain('<dd>85,089</dd>');
    expect(html).toContain('<dd>8,562,370</dd>');
    expect(html).toContain('<dd>9,127,893</dd>');
    expect(html).toContain('<dd>1</dd>');
    // AIU: 536_264_925_000 nano / 1e9 = 536.26 (2-dp when ≥ 1).
    expect(html).toContain('<dd>536.26</dd>');
  });

  it('always renders the card, even for a zeroed (non-agent) session', () => {
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).toContain('Agent run totals');
    // Errors / turns read 0 rather than being omitted.
    expect(html).toContain('title="Copilot Usage (AIU)">AIU</dt>');
  });

  it('plots an input/cached/output token trend across turns (≥ 2 turns)', () => {
    const turn = (input: number, output: number, cached: number): SessionTurn => ({
      timestampMs: 1_700_000_000_000,
      agentMode: 'agent',
      model: 'gpt-test',
      durationMs: 1,
      success: true,
      llmCalls: 1,
      inputTokens: input,
      outputTokens: output,
      cachedTokens: cached,
      reasoningTokens: 0,
      events: [],
    });
    const html = renderSessionDetailHtml(
      { ...treeDetail, turns: [turn(100, 20, 5), turn(200, 40, 50)] },
      [],
      NONCE,
    );
    // One polyline (and point dots) per series, plus a legend swatch for each.
    expect(html).toContain('class="trend-line trend-input"');
    expect(html).toContain('class="trend-line trend-cached"');
    expect(html).toContain('class="trend-line trend-output"');
    expect(html).toContain('class="trend-dot trend-output"');
    expect(html).toContain('class="trend-swatch trend-output"');
    // X-axis + grid background, but NO y-axis scale (read values on hover instead).
    expect(html).toContain('class="trend-axis"');
    expect(html).toContain('class="trend-grid"');
    expect(html).toContain('class="trend-axis-label trend-axis-x"');
    expect(html).not.toContain('trend-axis-y');
    // Per-turn hover columns expose every line's value via a native <title> tooltip.
    expect(html).toContain('class="trend-hover"');
    expect(html).toContain('<title>Turn 1 · Input 100 · Cached 5 · Output 20</title>');
    expect(html).toContain('<title>Turn 2 · Input 200 · Cached 50 · Output 40</title>');
    // CSP-safe: SVG geometry only, no inline style attributes anywhere.
    expect(html).toContain('<svg class="trend-svg"');
    expect(html).not.toContain('style="');
  });

  it('shows a placeholder instead of a trend when there are fewer than two turns', () => {
    const html = renderSessionDetailHtml(treeDetail, [], NONCE); // treeDetail has no turns
    expect(html).toContain('Not enough turns to plot a token trend.');
    expect(html).not.toContain('class="trend-line');
  });
});
