import { describe, it, expect } from 'vitest';
import { renderSessionDetailHtml } from './sessionDetailHtml';
import { SessionDetail, SessionTreeStats, SessionTurn } from '../telemetry/models';
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
  linesOfCode: 0,
  linesOfDoc: 0,
  linesOfCodeRemoved: 0,
  linesOfDocRemoved: 0,
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
    expect(html).not.toContain('Est. cost');
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

describe('renderSessionDetailHtml — Main agent AIU & cost', () => {
  /**
   * The Main agent table is driven by `agentUsage` (kind `main`). Cost is derived
   * directly from each row's AIU at the fixed $0.01/AIU rate and shown inline in the
   * AIU column (`X.XX ($Y.YY)`) — there is no separate cost column and no `n/a`:
   * - `claude-opus-4-6`: 2.0425 AIU → `2.04 ($0.02)`;
   * - `gpt-zero`: zero AIU → `0` (not billed, no `$`);
   * - `<script>evil</script>`: 0.5 AIU (XSS-laden id, must be escaped).
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

  /** Extract the rendered `<tfoot>` Total row so footer cells can be asserted in isolation. */
  function footerRow(html: string): string {
    return html.match(/<td>Total<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
  }

  it('renders the "Main agent" heading and an AIU column (no separate cost column)', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE);
    expect(html).toContain('<h2>Main agent</h2>');
    // The standalone estimate column is gone; cost is carried inline on AIU.
    expect(html).not.toContain('Est. cost');
    expect(html).not.toContain('(est.)');
    expect(html).not.toContain('n/a');
  });

  it('shows the per-row AIU with its derived dollar cost inline', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE);
    // 2_042_500_000 nano → 2.0425 AIU → 2.04, × $0.01 = $0.02.
    expect(html).toContain('2.04 ($0.02)');
  });

  it('shows a bare 0 (no dollar figure) for a model with no billed AIU', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE);
    // gpt-zero has aiuNano 0 → "0", never "0 ($0.00)".
    expect(html).toMatch(/gpt-zero<\/td>[\s\S]*?<td class="n">0<\/td>[\s\S]*?<\/tr>/);
  });

  it('renders a footer Total row that sums the per-row token and AIU columns', () => {
    const footer = footerRow(renderSessionDetailHtml(usageDetail, [], NONCE));
    expect(footer).toContain('<td class="n">4</td>'); // llmCalls 2 + 1 + 1
    expect(footer).toContain('<td class="n">1000</td>'); // input 800 + 0 + 200
    expect(footer).toContain('<td class="n">200</td>'); // output 150 + 0 + 50
    expect(footer).toContain('<td class="n">100</td>'); // cached 100 + 0 + 0
    // AIU 2_042_500_000 + 0 + 500_000_000 = 2_542_500_000 → 2.5425 → 2.54, × $0.01 = $0.03.
    expect(footer).toContain('2.54 ($0.03)');
  });

  it('escapes a model id containing markup', () => {
    const html = renderSessionDetailHtml(usageDetail, [], NONCE);
    expect(html).toContain('&lt;script&gt;evil&lt;/script&gt;');
    expect(html).not.toContain('<script>evil</script>');
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
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
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
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
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
      linesOfCode: 742,
      linesOfDoc: 196,
      linesOfCodeRemoved: 88,
      linesOfDocRemoved: 14,
    },
  };

  it('renders all twelve totals as an acronym flat list with the agent-tree values', () => {
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
      ['LOC', 'Lines of Code (added)'],
      ['LOD', 'Lines of Documentation (added)'],
      ['nLOC', 'Lines of Code (removed)'],
      ['nLOD', 'Lines of Documentation (removed)'],
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
    // AIU: 536_264_925_000 nano / 1e9 = 536.26 (2-dp when ≥ 1), with the derived
    // cost at $0.01/AIU shown inline (536.264925 × $0.01 = $5.36).
    expect(html).toContain('<dd>536.26 ($5.36)</dd>');
    // LoC/LoD added and removed both shown as positive counts (the "n" prefix on the
    // removal acronyms already denotes negative/removed lines).
    expect(html).toContain('<dd>742</dd>');
    expect(html).toContain('<dd>196</dd>');
    expect(html).toContain('<dd>88</dd>');
    expect(html).toContain('<dd>14</dd>');
  });

  it('always renders the card, even for a zeroed (non-agent) session', () => {
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).toContain('Agent run totals');
    // Errors / turns read 0 rather than being omitted.
    expect(html).toContain('title="Copilot Usage (AIU)">AIU</dt>');
  });

  const TREND_BASE_TS = 1_700_000_000_000;
  const trendTurn = (
    input: number,
    output: number,
    cached: number,
    lines: Partial<
      Pick<SessionTurn, 'linesOfCode' | 'linesOfDoc' | 'linesOfCodeRemoved' | 'linesOfDocRemoved'>
    > = {},
    // The trend now buckets by time, so each turn needs its own minute slot to plot
    // as a distinct point. Offset is in minutes from TREND_BASE_TS.
    minuteOffset = 0,
  ): SessionTurn => ({
    timestampMs: TREND_BASE_TS + minuteOffset * 60_000,
    agentMode: 'agent',
    model: 'gpt-test',
    durationMs: 1,
    success: true,
    llmCalls: 1,
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    ...lines,
    events: [],
  });

  it('plots an input/cached/output token trend across time (≥ 2 buckets)', () => {
    const html = renderSessionDetailHtml(
      { ...treeDetail, turns: [trendTurn(100, 20, 5, {}, 0), trendTurn(200, 40, 50, {}, 1)] },
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
    // Each line dot is a hover group: a marker, an on-hover value label, and a
    // transparent hit circle. The label carries that turn's token count for the series.
    expect(html).toContain('class="trend-dot-col"');
    expect(html).toContain('class="trend-dot-hit"');
    expect(html).toContain('class="trend-dot-value trend-dot-val-output"');
    // Turns with no line changes draw no stapel, so they expose no hit rect or tooltip
    // (token values are read from the dot labels instead).
    expect(html).not.toContain('class="trend-col-hit"');
    expect(html).not.toContain('<title>Turn 1');
    // CSP-safe: SVG geometry only, no inline style attributes anywhere.
    expect(html).toContain('<svg class="trend-svg"');
    expect(html).not.toContain('style="');
  });

  it('plots LoC/LoD as stacked bars (added and removed) on the trend', () => {
    const html = renderSessionDetailHtml(
      {
        ...treeDetail,
        turns: [
          trendTurn(100, 20, 5, { linesOfCode: 30, linesOfDoc: 10 }, 0),
          trendTurn(200, 40, 50, { linesOfCode: 12, linesOfCodeRemoved: 8, linesOfDocRemoved: 4 }, 1),
        ],
      },
      [],
      NONCE,
    );
    // A <rect> bar per non-zero stack segment, with its class.
    expect(html).toContain('class="trend-bar trend-bar-loc"');
    expect(html).toContain('class="trend-bar trend-bar-lod"');
    expect(html).toContain('class="trend-bar trend-bar-nloc"');
    expect(html).toContain('class="trend-bar trend-bar-nlod"');
    // The hover tooltip reports removed counts as positive numbers.
    expect(html).toContain('· LoC 12 · LoD 0 · nLoC 8 · nLoD 4</title>');
    // On-bar value labels (revealed on hover via CSS) carry the per-segment counts,
    // coloured to match their bar segment.
    expect(html).toContain('class="trend-bar-value"');
    expect(html).toContain('class="trend-val-loc"');
    expect(html).toContain('class="trend-val-nloc"');
    // Legend gains the four line-count swatches.
    expect(html).toContain('class="trend-swatch trend-loc"');
    expect(html).toContain('class="trend-swatch trend-nlod"');
    // Still CSP-safe (geometry + classes only).
    expect(html).not.toContain('style="');
  });

  it('shows a placeholder instead of a trend when there are fewer than two turns', () => {
    const html = renderSessionDetailHtml(treeDetail, [], NONCE); // treeDetail has no turns
    expect(html).toContain('Not enough turns to plot a token trend.');
    expect(html).not.toContain('class="trend-line');
  });

  it('aggregates turns sharing a minute slot into one bucket', () => {
    // Two turns in minute 0 (0s and 20s) and one in minute 1 → 2 buckets, not 3.
    const t0a = trendTurn(100, 20, 5, { linesOfCode: 10 }, 0);
    const t0b: SessionTurn = {
      ...trendTurn(50, 10, 2, { linesOfCode: 5 }, 0),
      timestampMs: TREND_BASE_TS + 20_000,
    };
    const t1 = trendTurn(200, 40, 50, { linesOfCode: 7 }, 1);
    const html = renderSessionDetailHtml({ ...treeDetail, turns: [t0a, t0b, t1] }, [], NONCE);
    // The minute-0 bucket sums both its turns' lines: LoC 10 + 5 = 15.
    expect(html).toContain('· LoC 15 ·');
    // x-axis labels are clock times (HH:MM), not turn numbers.
    expect(html).toMatch(/class="trend-axis-label trend-axis-x"[^>]*>\d{2}:\d{2}</);
  });

  it('collapses sub-minute turns to a single bucket (placeholder, nothing to plot)', () => {
    // Two turns 30s apart fall in the same 1-minute slot → one bucket → no line.
    const a = trendTurn(100, 20, 5, {}, 0);
    const b: SessionTurn = { ...trendTurn(200, 40, 50, {}, 0), timestampMs: TREND_BASE_TS + 30_000 };
    const html = renderSessionDetailHtml({ ...treeDetail, turns: [a, b] }, [], NONCE);
    expect(html).toContain('Not enough turns to plot a token trend.');
    expect(html).not.toContain('class="trend-line');
  });

  it('switches to 5-minute buckets once the span passes 15 minutes', () => {
    // Turns 0 and 16 min apart → span ≥ 15 min → 5-min slots; still plots a trend.
    const html = renderSessionDetailHtml(
      { ...treeDetail, turns: [trendTurn(100, 20, 5, {}, 0), trendTurn(200, 40, 50, {}, 16)] },
      [],
      NONCE,
    );
    expect(html).toContain('class="trend-line trend-input"');
  });
});
