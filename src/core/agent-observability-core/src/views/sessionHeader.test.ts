import { describe, it, expect } from 'vitest';
import { renderSessionDetailContent } from './sessionDetailHtml';
import { SessionDetail, SessionTreeStats } from '../telemetry/models';

/**
 * The session header's repository and agent-run rows.
 *
 * Both are links the host opens in a browser, which makes them the one place in
 * this document where a value becomes a URL — so what a link is made of, and
 * what deliberately does NOT become one, is worth pinning down.
 */

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

function detailWith(summary: Partial<SessionDetail['summary']>): SessionDetail {
  return {
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
      ...summary,
    },
    treeStats: ZERO_TREE_STATS,
    turns: [],
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
  };
}

function render(summary: Partial<SessionDetail['summary']>): string {
  return renderSessionDetailContent(detailWith(summary), []);
}

describe('repository row', () => {
  it('shows the repository, shortened to the part that identifies it', () => {
    const html = render({ repository: 'https://github.com/org/repo' });
    expect(html).toContain('<dt>Repository</dt>');
    expect(html).toContain('org/repo');
  });

  it('links a web remote and keeps the full URL for the tooltip', () => {
    const html = render({ repository: 'https://github.com/org/repo' });
    expect(html).toContain('class="repo-link"');
    expect(html).toContain('data-url="https://github.com/org/repo"');
    expect(html).toContain('title="https://github.com/org/repo"');
  });

  it('omits the row entirely when the repository could not be resolved', () => {
    // "unknown" is common and saying it adds nothing.
    expect(render({ repository: 'unknown' })).not.toContain('<dt>Repository</dt>');
  });

  it('shows a non-web remote as plain text rather than a dead link', () => {
    // Handing an ssh remote or a local path to a URL opener does nothing useful.
    const html = render({ repository: 'git@github.com:org/repo.git' });
    expect(html).toContain('<dt>Repository</dt>');
    expect(html).not.toContain('class="repo-link"');
  });

  it('refuses to link a non-http scheme', () => {
    const html = render({ repository: 'javascript:alert(1)' });
    expect(html).not.toContain('class="repo-link"');
    expect(html).not.toContain('data-url="javascript:alert(1)"');
  });

  it('escapes a repository carrying markup', () => {
    const html = render({ repository: 'https://example.com/"><img src=x onerror=alert(1)>' });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&quot;');
  });
});

describe('agent run row', () => {
  it('links an external run when the source provides one', () => {
    const html = render({ externalUrl: 'https://github.com/org/repo/pull/7' });
    expect(html).toContain('<dt>Agent run</dt>');
    expect(html).toContain('data-url="https://github.com/org/repo/pull/7"');
  });

  it('is absent for local sources, which have no run to open', () => {
    expect(render({})).not.toContain('<dt>Agent run</dt>');
  });
});

describe('the rest of the header', () => {
  it('still reports when the session ran', () => {
    const html = render({});
    expect(html).toContain('<dt>Started</dt>');
    expect(html).toContain('<dt>Ended</dt>');
    expect(html).toContain('<dt>Duration</dt>');
  });
});
