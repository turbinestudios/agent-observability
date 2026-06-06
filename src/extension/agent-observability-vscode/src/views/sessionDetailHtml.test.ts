import { describe, it, expect } from 'vitest';
import { renderSessionDetailHtml, SessionCostView } from './sessionDetailHtml';
import { SessionDetail } from '../telemetry/models';
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
  timeline: [],
  modelUsage: [],
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
    timeline: [],
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
