import { describe, it, expect } from 'vitest';
import {
  renderRepositoryDetailHtml,
  renderRepositoryDetailContent,
  repoShortName,
  RepositoryDetailView,
} from './sessionDetailHtml';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';
import { SessionDetail } from '../telemetry/models';

/**
 * Rendering tests for the LOCAL repository-detail webview: the aggregate-only
 * layout (header + totals tiles + agent tables), the deliberate EXCLUSIONS
 * (no trend, no dates, no timeline, no context analysis), the combined header's
 * repository list, and XSS-escaping of repository strings. The merge itself is
 * covered by combinedSessionDetail.test.ts.
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
  repositories: RepositoryDetailView['repositories'],
  over: Partial<RepositoryDetailView> = {},
): RepositoryDetailView {
  return {
    combined: combineSessionDetails(sessions),
    repositories,
    failedSessions: 0,
    ...over,
  };
}

describe('renderRepositoryDetailHtml', () => {
  it('renders the single-repo header and the merged "Agent run totals" tiles', () => {
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

    const html = renderRepositoryDetailHtml(
      viewFor([a, b], [{ repository: 'https://github.com/org/repo', sessionCount: 2 }]),
      NONCE,
    );

    expect(html).toContain('<title>Repository org/repo</title>');
    expect(html).toContain('>Repository</p>');
    expect(html).toContain('<h1>org/repo</h1>');
    // The header names the full repository URL and how many sessions loaded.
    expect(html).toContain('https://github.com/org/repo');
    expect(html).toContain('2 sessions included');
    // Merged tiles: model turns 2+5=7; TT re-derived over the disjoint buckets:
    // input 300 + cached 30 + output 100 = 430; AIU 1+3 = 4.
    expect(html).toContain('Agent run totals');
    expect(html).toContain('>7<'); // MT
    expect(html).toContain('>430<'); // TT
    expect(html).toContain('4.00'); // AIU
  });

  it('renders the merged main-agent and sub-agent tables', () => {
    const a = session({ sessionId: 'a-1' }, {
      agentUsage: [
        { agentName: 'Main agent', model: 'gpt', kind: 'main', llmCalls: 1, inputTokens: 10, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0, aiuNano: 1_000_000_000, linesOfCode: 7, linesOfDoc: 1, linesOfCodeRemoved: 2, linesOfDocRemoved: 0 },
        { agentName: 'Sub-agent: Search', model: 'gpt', kind: 'subagent', llmCalls: 4, inputTokens: 50, outputTokens: 9, cachedTokens: 0, reasoningTokens: 0, aiuNano: 0, linesOfCode: 0, linesOfDoc: 0, linesOfCodeRemoved: 0, linesOfDocRemoved: 0 },
      ],
    });
    const b = session({ sessionId: 'b-2' }, {
      agentUsage: [
        { agentName: 'Main agent', model: 'gpt', kind: 'main', llmCalls: 2, inputTokens: 20, outputTokens: 5, cachedTokens: 0, reasoningTokens: 0, aiuNano: 3_000_000_000, linesOfCode: 13, linesOfDoc: 2, linesOfCodeRemoved: 5, linesOfDocRemoved: 1 },
      ],
    });

    const html = renderRepositoryDetailHtml(
      viewFor([a, b], [{ repository: 'https://github.com/org/repo', sessionCount: 2 }]),
      NONCE,
    );

    expect(html).toContain('<h2>Main agent</h2>');
    expect(html).toContain('<h2>Spawned sub-agents</h2>');
    expect(html).toContain('Sub-agent: Search');
    // Merged main-agent input tokens 10 + 20 appear in the table.
    expect(html).toContain('>30<');
  });

  it('excludes the trend, dates, timeline, and context analysis', () => {
    const a = session({ sessionId: 'a-1' }, {
      // Model-turn points exist on the details, but the repository view must not
      // plot them (nor show the too-few-points placeholder).
      treeModelTurns: [
        { timestampMs: 0, model: 'gpt', inputTokens: 10, outputTokens: 1, cachedTokens: 0, reasoningTokens: 0, linesOfCode: 0, linesOfDoc: 0, linesOfCodeRemoved: 0, linesOfDocRemoved: 0 },
        { timestampMs: 1, model: 'gpt', inputTokens: 20, outputTokens: 2, cachedTokens: 0, reasoningTokens: 0, linesOfCode: 0, linesOfDoc: 0, linesOfCodeRemoved: 0, linesOfDocRemoved: 0 },
      ],
    });

    // Assert on the BODY (what the view actually shows) — the full document's
    // embedded stylesheet/controller legitimately mention these class names.
    const content = renderRepositoryDetailContent(
      viewFor([a], [{ repository: 'https://github.com/org/repo', sessionCount: 1 }]),
    );

    expect(content).not.toContain('tree-trend');
    expect(content).not.toContain('Not enough model turns');
    expect(content).not.toContain('<dt>Started</dt>');
    expect(content).not.toContain('<dt>Ended</dt>');
    expect(content).not.toContain('<dt>Duration</dt>');
    expect(content).not.toContain('tab-bar');
    expect(content).not.toContain('Context Analysis');
    expect(content).not.toContain('turn-request');
    expect(content).not.toContain('<h2>Timeline</h2>');
  });

  it('lists every covered repository with its session count in the combined header', () => {
    const a = session({ sessionId: 'a-1', repository: 'https://github.com/org/repo-a' });
    const b = session({ sessionId: 'b-2', repository: 'https://github.com/org/repo-b' });

    const html = renderRepositoryDetailHtml(
      viewFor(
        [a, b],
        [
          { repository: 'https://github.com/org/repo-a', sessionCount: 12 },
          { repository: 'https://github.com/org/repo-b', sessionCount: 1 },
        ],
      ),
      NONCE,
    );

    expect(html).toContain('<title>Combined repositories (2)</title>');
    expect(html).toContain('>Combined repositories</p>');
    expect(html).toContain('<h1>2 repositories</h1>');
    expect(html).toMatch(/<dt>https:\/\/github\.com\/org\/repo-a<\/dt><dd>12 sessions<\/dd>/);
    expect(html).toMatch(/<dt>https:\/\/github\.com\/org\/repo-b<\/dt><dd>1 session<\/dd>/);
  });

  it('mounts the live shell; the update body carries no document shell', () => {
    const view = viewFor([session({ sessionId: 'a-1' })], [{ repository: 'https://github.com/org/repo', sessionCount: 1 }]);

    const html = renderRepositoryDetailHtml(view, NONCE);
    expect(html).toContain('<div id="live-root">');

    const content = renderRepositoryDetailContent(view);
    expect(content).not.toContain('<!DOCTYPE');
    expect(content).toContain('Agent run totals');
  });

  it('escapes a hostile repository string', () => {
    const evil = 'https://h/<img src=x onerror=alert(1)>';
    const html = renderRepositoryDetailHtml(
      viewFor([session({ sessionId: 'a-1' })], [{ repository: evil, sessionCount: 1 }]),
      NONCE,
    );
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x');
  });

  it('surfaces failed session loads and the source truncation note', () => {
    const html = renderRepositoryDetailHtml(
      viewFor(
        [session({ sessionId: 'a-1' })],
        [{ repository: 'https://github.com/org/repo', sessionCount: 1 }],
        { failedSessions: 3, truncationNote: 'Showing the 150 most recent sessions.' },
      ),
      NONCE,
    );
    expect(html).toContain('3 session(s) could not be loaded');
    expect(html).toContain('Showing the 150 most recent sessions.');
  });

  it('shows the cost tile matching the cost mode', () => {
    const withCost = session({ sessionId: 'a-1' }, {
      treeStats: {
        modelTurns: 1, toolCalls: 0, inputTokens: 10, outputTokens: 5,
        cachedTokens: 0, totalTokens: 15, errorCount: 0, aiuNano: 2_000_000_000,
        costUsdMicros: 1_250_000,
        linesOfCode: 0, linesOfDoc: 0, linesOfCodeRemoved: 0, linesOfDocRemoved: 0,
      },
    });
    const repositories = [{ repository: 'https://github.com/org/repo', sessionCount: 1 }];

    const usd = renderRepositoryDetailHtml(viewFor([withCost], repositories), NONCE, 'usd');
    expect(usd).toContain('Estimated Cost (USD)');
    expect(usd).toContain('$1.25');
    expect(usd).not.toContain('Copilot Usage (AIU)');

    const aiu = renderRepositoryDetailHtml(viewFor([withCost], repositories), NONCE, 'aiu');
    expect(aiu).toContain('Copilot Usage (AIU)');
    expect(aiu).not.toContain('Estimated Cost (USD)');
  });
});

describe('repoShortName', () => {
  it('shortens a sanitized repository URL to owner/repo', () => {
    expect(repoShortName('https://github.com/org/repo')).toBe('org/repo');
  });

  it('keeps the last two segments of a deeper path', () => {
    expect(repoShortName('https://gitlab.example.com/group/subgroup/repo')).toBe('subgroup/repo');
  });

  it('falls back to the single segment when there is only one', () => {
    expect(repoShortName('https://host/repo')).toBe('repo');
  });

  it('labels the unknown bucket readably', () => {
    expect(repoShortName('unknown')).toBe('Unknown repository');
  });
});
