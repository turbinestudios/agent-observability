import { describe, it, expect } from 'vitest';
import { renderSessionDetailHtml } from './sessionDetailHtml';
import { SessionDetail } from '../telemetry/models';
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
});
