import { describe, it, expect } from 'vitest';
import { renderSessionDetailHtml } from '../views/sessionDetailHtml';
import type { SessionDetail, SessionTreeStats } from '../telemetry/models';
import type { SessionContextAnalysis, AgentContextAnalysis } from './models';

/** Minimal valid SessionDetail for rendering tests. */
function minimalDetail(): SessionDetail {
  const treeStats: SessionTreeStats = {
    modelTurns: 1,
    toolCalls: 0,
    inputTokens: 10000,
    outputTokens: 500,
    cachedTokens: 0,
    totalTokens: 10500,
    errorCount: 0,
    aiuNano: 0,
    linesOfCode: 0,
    linesOfDoc: 0,
    linesOfCodeRemoved: 0,
    linesOfDocRemoved: 0,
  };
  return {
    summary: {
      sessionId: 'test-session-id-1234',
      repository: 'test/repo',
      startedAtMs: 1700000000000,
      endedAtMs: 1700000060000,
      durationMs: 60000,
      interactionCount: 5,
      llmCalls: 1,
      toolCalls: 3,
      inputTokens: 10000,
      outputTokens: 500,
      cachedTokens: 0,
      model: 'gpt-4',
      agentModes: ['agent'],
    },
    treeStats,
    turns: [],
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
  };
}

function minimalContextAnalysis(): SessionContextAnalysis {
  const mainAgent: AgentContextAnalysis = {
    agentName: 'Main Agent',
    kind: 'main',
    loadedFiles: [
      { name: 'copilot-instructions.md', category: 'instruction', status: 'applied', estimatedTokens: 500, charCount: 2000 },
      { name: 'monorepo-structure.instructions.md', category: 'instruction', status: 'skipped', skipReason: "applyTo 'src/**' did not match" },
      { name: 'reflect', category: 'skill', status: 'applied', estimatedTokens: 1200, charCount: 4800 },
    ],
    expectedMissing: [
      {
        name: 'testing.instructions.md',
        referencedBy: [
          { sourceFile: 'copilot-instructions.md', referencedFile: 'testing.instructions.md', referenceType: 'name-ref' },
        ],
      },
    ],
    totalContextTokens: 10000,
    contextFileTokens: 1700,
    otherContextTokens: 8300,
    oversizedFiles: [],
  };

  const subagent: AgentContextAnalysis = {
    agentName: 'Subagent: Explore',
    kind: 'subagent',
    loadedFiles: [
      { name: 'copilot-instructions.md', category: 'instruction', status: 'applied', estimatedTokens: 500, charCount: 2000 },
    ],
    expectedMissing: [],
    totalContextTokens: 5000,
    contextFileTokens: 500,
    otherContextTokens: 4500,
    oversizedFiles: [],
  };

  const total: AgentContextAnalysis = {
    agentName: 'Total Overview',
    kind: 'total',
    loadedFiles: [...mainAgent.loadedFiles, ...subagent.loadedFiles.filter((f) => !mainAgent.loadedFiles.some((m) => m.name === f.name))],
    expectedMissing: mainAgent.expectedMissing,
    totalContextTokens: 10000,
    contextFileTokens: 1700,
    otherContextTokens: 8300,
    oversizedFiles: [],
  };

  return { total, agents: [mainAgent, subagent] };
}

describe('sessionDetailHtml — context analysis tab', () => {
  it('renders tab bar when context analysis is provided', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).toContain('class="tab-bar"');
    expect(html).toContain('data-tab="tab-overview"');
    expect(html).toContain('data-tab="tab-context"');
  });

  it('does not render tab bar when context analysis is undefined', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce');
    expect(html).not.toContain('class="tab-bar"');
    expect(html).not.toContain('data-tab="tab-context"');
  });

  it('renders Total Overview section open by default', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).toContain('Total Overview');
    // The total section should be open
    expect(html).toMatch(/ctx-section[^>]*\s+open/);
  });

  it('renders per-agent sections', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).toContain('Main Agent');
    expect(html).toContain('Subagent: Explore');
  });

  it('renders a provenance caption when a note is present', () => {
    const analysis = { ...minimalContextAnalysis(), note: 'Reconstructed from the transcript.' };
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', analysis);
    expect(html).toContain('class="ctx-note"');
    expect(html).toContain('Reconstructed from the transcript.');
  });

  it('omits the caption when no note is present (Copilot path)', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).not.toContain('class="ctx-note"');
  });

  it('renders loaded files table', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).toContain('copilot-instructions.md');
    expect(html).toContain('reflect');
    expect(html).toContain('Loaded context files');
  });

  it('renders expected-but-missing section', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).toContain('testing.instructions.md');
    expect(html).toContain('Expected but missing');
  });

  it('renders context budget bar', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).toContain('ctx-budget-bar');
    expect(html).toContain('Context window usage');
    // Widths must be applied via utility classes (CSP `style-src 'nonce-…'` blocks
    // inline `style="…"` attributes, so style attrs would render the bar invisible).
    // mainAgent: contextFileTokens=1700 / totalContextTokens=10000 → 17% / 83%.
    expect(html).toContain('ctx-budget-fill ctx-budget-files ctx-w-17');
    expect(html).toContain('ctx-budget-fill ctx-budget-other ctx-w-83');
    expect(html).not.toMatch(/ctx-budget-fill[^>]*\sstyle=/);
  });

  it('renders status badges correctly', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).toContain('ctx-status-applied');
    expect(html).toContain('ctx-status-skipped');
  });

  it('escapes HTML in file names', () => {
    const analysis = minimalContextAnalysis();
    analysis.total.loadedFiles.push({
      name: '<script>alert("xss")</script>.instructions.md',
      category: 'instruction',
      status: 'applied',
    });

    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', analysis);
    expect(html).not.toContain('<script>alert("xss")</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('renders oversized file warnings', () => {
    const analysis = minimalContextAnalysis();
    analysis.total.oversizedFiles = [
      { name: 'huge.instructions.md', category: 'instruction', status: 'applied', estimatedTokens: 5000, charCount: 20000 },
    ];
    analysis.total.loadedFiles.push(
      { name: 'huge.instructions.md', category: 'instruction', status: 'applied', estimatedTokens: 5000, charCount: 20000 },
    );

    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', analysis);
    expect(html).toContain('Oversized context files');
    expect(html).toContain('huge.instructions.md');
    expect(html).toContain('⚠️');
  });

  it('includes the tab switch script when context is provided', () => {
    const html = renderSessionDetailHtml(minimalDetail(), [], 'test-nonce', minimalContextAnalysis());
    expect(html).toContain("btn.getAttribute('data-tab')");
  });
});
