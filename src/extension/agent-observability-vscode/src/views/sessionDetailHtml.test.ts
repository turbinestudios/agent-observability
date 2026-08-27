import { describe, it, expect } from 'vitest';
import {
  renderSessionDetailHtml,
  renderSessionDetailContent,
  renderCombinedSessionDetailHtml,
} from './sessionDetailHtml';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';
import {
  SessionDetail,
  SessionTreeStats,
  SessionTurn,
  SessionModelTurnPoint,
} from '../telemetry/models';
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
  treeModelTurns: [],
};

/** A single user-request turn, so per-turn divergence chips have a place to render. */
const turnFixture: SessionTurn = {
  timestampMs: 1_000_000,
  agentMode: 'agent',
  model: 'gpt-test',
  durationMs: 1000,
  success: true,
  userRequest: 'do the thing',
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
const detailWithTurn: SessionDetail = { ...detail, turns: [turnFixture] };

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

describe('renderSessionDetailHtml — header title', () => {
  it('shows the session title as the heading with the short id in the eyebrow', () => {
    const titled: SessionDetail = {
      ...detail,
      summary: { ...detail.summary, title: 'Fix the <login> bug', titleDerived: false },
    };
    const html = renderSessionDetailHtml(titled, [], NONCE);
    expect(html).toContain('<h1>Fix the &lt;login&gt; bug</h1>');
    expect(html).toContain('<p class="eyebrow">Session · abc</p>');
    expect(html).toContain('<title>Fix the &lt;login&gt; bug</title>');
  });

  it('falls back to the short session id when no title is known', () => {
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).toContain('<h1>abc</h1>');
    expect(html).toContain('<p class="eyebrow">Session</p>');
    expect(html).toContain('<title>Session abc</title>');
  });

  it('truncates an over-long title in the heading', () => {
    const long = 'x'.repeat(120);
    const titled: SessionDetail = {
      ...detail,
      summary: { ...detail.summary, title: long, titleDerived: true },
    };
    const html = renderSessionDetailHtml(titled, [], NONCE);
    expect(html).toContain(`<h1>${'x'.repeat(80)}…</h1>`);
  });
});

describe('renderSessionDetailHtml — local-only badge', () => {
  // The `.badge-local` CSS rule is always in the <style> block, so assert on the
  // rendered badge ELEMENT (class attribute + visible text), not the bare class.
  it('renders a "Local only" badge for a content-derived per-turn deviation', () => {
    const html = renderSessionDetailHtml(
      detailWithTurn,
      [[deviation({ contentDerived: true, description: "Workflow step 'no-secrets' content condition not met." })]],
      NONCE,
    );
    expect(html).toContain('class="turn-deviations"');
    expect(html).toContain('class="badge badge-local"');
    expect(html).toContain('>Local only</span>');
  });

  it('does not render the badge for a metadata-only deviation', () => {
    const html = renderSessionDetailHtml(
      detailWithTurn,
      [[deviation({ type: DeviationType.TimeoutExceeded, description: 'too long' })]],
      NONCE,
    );
    expect(html).toContain('class="turn-deviations"');
    expect(html).not.toContain('class="badge badge-local"');
    expect(html).not.toContain('>Local only</span>');
  });

  it('renders no divergence chips when the turn has none', () => {
    const html = renderSessionDetailHtml(detailWithTurn, [[]], NONCE);
    expect(html).not.toContain('class="turn-deviations"');
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

describe('renderSessionDetailHtml — header duration tiers', () => {
  const withDuration = (durationMs: number): SessionDetail => ({
    ...detail,
    summary: { ...detail.summary, durationMs },
  });

  it('renders sub-minute durations as decimal seconds', () => {
    const html = renderSessionDetailHtml(withDuration(45_000), [], NONCE);
    expect(html).toContain('<dd>45.0 s</dd>');
  });

  it('renders minute-scale durations as m/s, not raw seconds', () => {
    // The `detail` fixture's own 60 000 ms.
    const html = renderSessionDetailHtml(detail, [], NONCE);
    expect(html).toContain('<dd>1m 0s</dd>');
    expect(html).not.toContain('60.0 s');
  });

  it('renders hour-scale durations as h/m/s', () => {
    const html = renderSessionDetailHtml(withDuration(5_432_100), [], NONCE);
    expect(html).toContain('<dd>1h 30m 32s</dd>');
  });

  it('never rounds up to a 60-minute remainder', () => {
    // 3 599 600 ms rounds to 3600 s: must decompose to 1h 0m 0s, not 60m 0s.
    const html = renderSessionDetailHtml(withDuration(3_599_600), [], NONCE);
    expect(html).toContain('<dd>1h 0m 0s</dd>');
  });
});

describe('renderSessionDetailHtml — live in-place update shell', () => {
  // The panel mounts the full document ONCE, then pushes data as `update` messages
  // so the in-page controller swaps the body WITHOUT reloading — keeping open
  // collapsibles, the active tab, and scroll. These guard that contract.
  it('wraps the body in a single #live-root and mounts exactly one controller', () => {
    const html = renderSessionDetailHtml(detailWithTurn, [[]], NONCE);
    expect(html).toContain('<div id="live-root">');
    const scripts = [...html.matchAll(/<script nonce="[^"]*">/g)];
    expect(scripts).toHaveLength(1);
    // The controller acquires the API once and handles the live `update` message.
    expect(html).toContain('acquireVsCodeApi()');
    expect(html).toContain("msg.type !== 'update'");
  });

  it('the controller restores open collapsibles, the active tab, and scroll', () => {
    const html = renderSessionDetailHtml(detailWithTurn, [[]], NONCE);
    expect(html).toContain('details[data-k]'); // snapshot/restore keying
    expect(html).toContain('tab-btn-active'); // tab restore
    expect(html).toContain('window.scrollTo'); // scroll restore
  });

  it('renderSessionDetailContent returns just the body the panel posts as an update', () => {
    const content = renderSessionDetailContent(detailWithTurn, [[]]);
    // Body only — no document shell, styles, scripts, or the #live-root wrapper.
    expect(content).not.toContain('<!DOCTYPE');
    expect(content).not.toContain('<html');
    expect(content).not.toContain('<script');
    expect(content).not.toContain('id="live-root"');
    // It IS the live markup: the turn block is present.
    expect(content).toContain('User request');
  });

  it('keys each turn disclosure with a stable data-k so its open state survives a push', () => {
    const html = renderSessionDetailHtml(detailWithTurn, [[]], NONCE);
    expect(html).toContain('data-k="t0r"'); // user-request disclosure
    expect(html).toContain('data-k="t0l"'); // nested event timeline
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
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
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
    treeModelTurns: [],
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

  it('renders an em dash in Run time when the source has no timestamps', () => {
    // None of the usageDetail rows carry runDurationMs — a fake "0 ms" would
    // read as measured, so every row AND the footer must show the dash.
    const html = renderSessionDetailHtml(usageDetail, [], NONCE);
    expect(html).toContain('>Run time</th>');
    const rows = [...html.matchAll(/<td>Main agent<\/td>[\s\S]*?<\/tr>/g)];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row[0]).toContain('<td class="n">—</td>');
    }
    expect(footerRow(html)).toContain('<td class="n">—</td>');
    expect(html).not.toContain('0 ms');
  });
});

describe('renderSessionDetailHtml — Copilot (Cloud) credit units', () => {
  /** A cloud-style detail whose tree + main-agent rollup carry credits in `unit`. */
  const creditDetail = (creditsNano: number, unit: 'ai_credits' | 'pru'): SessionDetail => ({
    ...detail,
    treeStats: { ...ZERO_TREE_STATS, modelTurns: 1, creditsNano, creditUnit: unit },
    agentUsage: [
      {
        agentName: 'Copilot cloud agent',
        model: 'claude-sonnet-4.6',
        kind: 'main',
        llmCalls: 1,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        reasoningTokens: 0,
        aiuNano: 0,
        creditsNano,
        creditUnit: unit,
        linesOfCode: 0,
        linesOfDoc: 0,
        linesOfCodeRemoved: 0,
        linesOfDocRemoved: 0,
      },
    ],
  });

  it('renders a `pru` count as "Premium Requests" and a plain integer (not 0)', () => {
    // 3 premium requests are stored as 3e9 nano; the panel must show "3", not the
    // "0.0000" the old blanket /1e9 division produced for small pru counts.
    const html = renderSessionDetailHtml(creditDetail(3_000_000_000, 'pru'), [], NONCE, undefined, 'credits');
    expect(html).toContain('Premium Requests');
    expect(html).not.toContain('AI Credits');
    expect(html).toMatch(/Copilot cloud agent<\/td>[\s\S]*?<td class="n">3<\/td>/);
  });

  it('renders a legacy `ai_credits` value as "AI Credits" with decimals', () => {
    const html = renderSessionDetailHtml(creditDetail(10_191_735_000, 'ai_credits'), [], NONCE, undefined, 'credits');
    expect(html).toContain('AI Credits');
    expect(html).not.toContain('Premium Requests');
    expect(html).toContain('10.19');
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
      { agentName: 'GitHub Copilot Chat', model: 'gpt-5.4', kind: 'main', llmCalls: 3, inputTokens: 5000, outputTokens: 200, cachedTokens: 100, reasoningTokens: 0, aiuNano: 3_000_000_000, linesOfCode: 120, linesOfDoc: 18, linesOfCodeRemoved: 30, linesOfDocRemoved: 4, runDurationMs: 4_215_000 },
      { agentName: 'Testing', model: 'gpt-5.3-codex', kind: 'subagent', llmCalls: 2, inputTokens: 1300, outputTokens: 40, cachedTokens: 0, reasoningTokens: 0, aiuNano: 0, linesOfCode: 45, linesOfDoc: 0, linesOfCodeRemoved: 12, linesOfDocRemoved: 0, runDurationMs: 300_000 },
      { agentName: 'Frontend', model: 'gpt-5.4', kind: 'subagent', llmCalls: 1, inputTokens: 900, outputTokens: 10, cachedTokens: 0, reasoningTokens: 0, aiuNano: 0, linesOfCode: 60, linesOfDoc: 5, linesOfCodeRemoved: 8, linesOfDocRemoved: 1, runDurationMs: 65_000 },
    ],
    treeModelTurns: [],
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

  it('renders LoC/LoD/nLoC/nLoD columns per (agent, model) in both tables', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    // Column headers exist (LoC / LoD additions, nLoC / nLoD removals).
    expect(html).toContain('>LoC</th>');
    expect(html).toContain('>LoD</th>');
    expect(html).toContain('>nLoC</th>');
    expect(html).toContain('>nLoD</th>');
    // Main-thread row carries its own line counts (120/18/30/4).
    const mainRow = html.match(/<td>GitHub Copilot Chat<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(mainRow).toMatch(/<td class="n">120<\/td>\s*<td class="n">18<\/td>\s*<td class="n">30<\/td>\s*<td class="n">4<\/td>/);
    // A sub-agent row carries its own (45/0/12/0).
    const subRow = html.match(/<td>Testing<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(subRow).toMatch(/<td class="n">45<\/td>\s*<td class="n">0<\/td>\s*<td class="n">12<\/td>\s*<td class="n">0<\/td>/);
  });

  it('renders a Run time column with per-row wall-clock spans', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    expect(html).toContain('>Run time</th>');
    const mainRow = html.match(/<td>GitHub Copilot Chat<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(mainRow).toContain('<td class="n">1h 10m 15s</td>'); // 4 215 000 ms
    const testingRow = html.match(/<td>Testing<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(testingRow).toContain('<td class="n">5m 0s</td>'); // 300 000 ms
    const frontendRow = html.match(/<td>Frontend<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(frontendRow).toContain('<td class="n">1m 5s</td>'); // 65 000 ms
  });

  it('sub-agent subtotal sums the run time of the sub-agent rows only', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    const sub = html.match(/<td>Sub-agent total<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    expect(sub).toContain('<td class="n">6m 5s</td>'); // 300 000 + 65 000 ms
  });

  it('sub-agent subtotal sums the per-agent LoC/LoD columns', () => {
    const html = renderSessionDetailHtml(agentDetail, [], NONCE);
    const sub = html.match(/<td>Sub-agent total<\/td>[\s\S]*?<\/tr>/)?.[0] ?? '';
    // LoC 45 + 60 = 105, LoD 0 + 5 = 5, nLoC 12 + 8 = 20, nLoD 0 + 1 = 1.
    expect(sub).toMatch(/<td class="n">105<\/td>\s*<td class="n">5<\/td>\s*<td class="n">20<\/td>\s*<td class="n">1<\/td>/);
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
  // One whole-tree model turn (a trend point), at `secondOffset` seconds past
  // TREND_BASE_TS. The x-axis is ordinal, so the timestamp only orders the series.
  const point = (
    input: number,
    output: number,
    cached: number,
    lines: Partial<
      Pick<
        SessionModelTurnPoint,
        'linesOfCode' | 'linesOfDoc' | 'linesOfCodeRemoved' | 'linesOfDocRemoved'
      >
    > = {},
    secondOffset = 0,
  ): SessionModelTurnPoint => ({
    timestampMs: TREND_BASE_TS + secondOffset * 1000,
    model: 'gpt-test',
    inputTokens: input,
    outputTokens: output,
    cachedTokens: cached,
    reasoningTokens: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
    ...lines,
  });

  it('plots an input/cached/output token trend across model turns (≥ 2 points)', () => {
    const html = renderSessionDetailHtml(
      { ...treeDetail, treeModelTurns: [point(100, 20, 5, {}, 0), point(200, 40, 50, {}, 30)] },
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
    // x-axis labels are ordinal MODEL-TURN NUMBERS (1-based), never clock times.
    expect(html).toMatch(/class="trend-axis-label trend-axis-x"[^>]*>1</);
    expect(html).not.toMatch(/class="trend-axis-label trend-axis-x"[^>]*>\d{2}:\d{2}</);
    // Each line dot is a hover group: a marker, an on-hover value label, and a
    // transparent hit circle. The label carries that turn's token count for the series.
    // All dot groups live inside one `.trend-dots` layer — the legend-filter script
    // rebuilds that layer's contents whenever the filter changes.
    expect(html).toContain('<g class="trend-dots">');
    expect(html).toContain('class="trend-dot-col"');
    expect(html).toContain('class="trend-dot-hit"');
    expect(html).toContain('class="trend-dot-value trend-dot-val-output"');
    // Points with no line changes draw no stapel, so they expose no hit rect.
    expect(html).not.toContain('class="trend-col-hit"');
    // CSP-safe: SVG geometry only, no inline style attributes anywhere.
    expect(html).toContain('<svg class="trend-svg"');
    expect(html).not.toContain('style="');
  });

  it('plots one point per whole-tree model turn', () => {
    // Five tree model turns → five plotted points, one per model turn.
    const html = renderSessionDetailHtml(
      {
        ...treeDetail,
        treeModelTurns: [
          point(100, 10, 0, {}, 0),
          point(110, 12, 0, {}, 20),
          point(120, 14, 0, {}, 40),
          point(200, 20, 0, {}, 60),
          point(210, 22, 0, {}, 80),
        ],
      },
      [],
      NONCE,
    );
    expect(html.match(/class="trend-dot trend-output"/g)?.length).toBe(5);
    // The x-axis is labelled by ordinal turn number; with 5 points all are labelled,
    // so the last tick reads "5" (never a clock time).
    expect(html).toMatch(/class="trend-axis-label trend-axis-x"[^>]*>5</);
  });

  it('plots LoC/LoD as stacked bars (added and removed) per model turn', () => {
    const html = renderSessionDetailHtml(
      {
        ...treeDetail,
        treeModelTurns: [
          point(100, 20, 5, { linesOfCode: 30, linesOfDoc: 10 }, 0),
          point(200, 40, 50, { linesOfCode: 12, linesOfCodeRemoved: 8, linesOfDocRemoved: 4 }, 30),
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
    // The hover tooltip reports removed counts as positive numbers, per model turn.
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

  it('shows a placeholder instead of a trend when there are fewer than two model turns', () => {
    // treeDetail has no model turns at all.
    const noTurns = renderSessionDetailHtml(treeDetail, [], NONCE);
    expect(noTurns).toContain('Not enough model turns to plot a token trend.');
    expect(noTurns).not.toContain('class="trend-line');
    // A single model turn is also just one point → placeholder.
    const onePoint = renderSessionDetailHtml(
      { ...treeDetail, treeModelTurns: [point(100, 20, 5, {}, 0)] },
      [],
      NONCE,
    );
    expect(onePoint).toContain('Not enough model turns to plot a token trend.');
    expect(onePoint).not.toContain('class="trend-line');
  });

  it('plots one point per model turn at or below the grouping threshold (25)', () => {
    const turns = Array.from({ length: 25 }, (_v, i) => point(100 + i, 10, 0, {}, i));
    const html = renderSessionDetailHtml({ ...treeDetail, treeModelTurns: turns }, [], NONCE);
    // 25 turns ≤ threshold → one dot per turn, no grouping note.
    expect(html.match(/class="trend-dot trend-output"/g)?.length).toBe(25);
    expect(html).not.toContain('grouped by');
  });

  it('buckets into groups of 5 once there are more than 25 model turns', () => {
    // 30 turns > threshold → 30 / 5 = 6 plotted points, each summing its group.
    const turns = Array.from({ length: 30 }, (_v, i) =>
      point(10, 1, 0, { linesOfCode: 2 }, i),
    );
    const html = renderSessionDetailHtml({ ...treeDetail, treeModelTurns: turns }, [], NONCE);
    expect(html.match(/class="trend-dot trend-output"/g)?.length).toBe(6);
    // The grouping is made explicit, and points read as turn RANGES that sum their
    // group: the first bucket covers turns 1–5 with input 10×5 = 50 and LoC 2×5 = 10.
    expect(html).toContain('grouped by 5 model turns');
    expect(html).toContain('<title>Turns 1–5 · Input 50 ·');
    expect(html).toContain('· LoC 10 ·');
    // x-axis labels are the group's last turn number (5, 10, …, 30), never a time.
    expect(html).toMatch(/class="trend-axis-label trend-axis-x"[^>]*>30</);
    expect(html).not.toMatch(/class="trend-axis-label trend-axis-x"[^>]*>\d{2}:\d{2}</);
  });

  it('keeps buckets within session boundaries in the combined view', () => {
    // Two sessions of 30 turns each → each buckets into 6 points (12 total), and the
    // turn numbering runs continuously across the sessions (session b is turns 31–60).
    const a: SessionDetail = {
      ...treeDetail,
      summary: { ...treeDetail.summary, sessionId: 'aaaa-1111' },
      treeModelTurns: Array.from({ length: 30 }, (_v, i) => point(10, 1, 0, { linesOfCode: 1 }, i)),
    };
    const b: SessionDetail = {
      ...treeDetail,
      summary: { ...treeDetail.summary, sessionId: 'bbbb-2222' },
      treeModelTurns: Array.from({ length: 30 }, (_v, i) => point(10, 1, 0, { linesOfCode: 1 }, i)),
    };
    const html = renderCombinedSessionDetailHtml(
      {
        combined: combineSessionDetails([a, b]),
        sections: [
          { detail: a, turnDeviations: [] },
          { detail: b, turnDeviations: [] },
        ],
      },
      NONCE,
    );
    expect(html.match(/class="trend-dot trend-output"/g)?.length).toBe(12);
    // Session b's first bucket is turns 31–35 (continuous numbering, aligned to the
    // session boundary rather than straddling it).
    expect(html).toContain('<title>Turns 31–35 ·');
    expect(html).toContain('class="trend-session-divider"');
  });

  it('emits a syntactically valid legend-filter script', () => {
    // The filter script is authored inside a TS template literal, where a stray
    // escape (e.g. an unescaped backslash in a regex) silently corrupts the emitted
    // JS. Parse every inline script to catch that class of mistake.
    const html = renderSessionDetailHtml(
      { ...treeDetail, treeModelTurns: [point(100, 20, 5, {}, 0), point(200, 40, 50, {}, 30)] },
      [],
      NONCE,
    );
    const scripts = [...html.matchAll(/<script nonce="[^"]*">([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, body] of scripts) {
      expect(() => new Function(body)).not.toThrow();
    }
  });
});
