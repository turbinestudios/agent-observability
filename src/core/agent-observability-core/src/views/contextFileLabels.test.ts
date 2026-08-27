import { describe, it, expect } from 'vitest';
import { renderSessionDetailHtml } from './sessionDetailHtml';
import { collapseRepeatedSeparators } from '../context/filePaths';
import { OVERSIZED_THRESHOLD_TOKENS } from '../context/sizeEstimator';
import type { AgentContextAnalysis, ContextFileEntry, SessionContextAnalysis } from '../context/models';
import { SessionDetail, SessionTreeStats } from '../telemetry/models';

/**
 * How the Context Analysis tab names files and explains size.
 *
 * Both matter because the list is otherwise unreadable in the common case: a
 * session that loads nine skills shows nine rows called `SKILL.md`, and a size
 * warning with no threshold leaves the reader unable to tell "slightly over"
 * from "fifteen times over".
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

const DETAIL: SessionDetail = {
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

function agent(over: Partial<AgentContextAnalysis>): AgentContextAnalysis {
  return {
    agentName: 'Main agent',
    kind: 'total',
    loadedFiles: [],
    expectedMissing: [],
    totalContextTokens: 10_000,
    contextFileTokens: 5_000,
    otherContextTokens: 5_000,
    oversizedFiles: [],
    ...over,
  };
}

function render(total: AgentContextAnalysis): string {
  const analysis: SessionContextAnalysis = { total, agents: [total] };
  return renderSessionDetailHtml(DETAIL, [], 'test-nonce', analysis);
}

function file(over: Partial<ContextFileEntry> & Pick<ContextFileEntry, 'name'>): ContextFileEntry {
  return { category: 'skill', status: 'applied', ...over };
}

describe('naming a context file', () => {
  it('prefixes a skill with its folder, which is the skill name', () => {
    const html = render(
      agent({
        loadedFiles: [file({ name: 'SKILL.md', filePath: 'c:/proj/.claude/skills/azure-pricing/SKILL.md' })],
      }),
    );
    expect(html).toContain('azure-pricing/SKILL.md');
  });

  it('keeps skills distinguishable when several are loaded', () => {
    const html = render(
      agent({
        loadedFiles: [
          file({ name: 'SKILL.md', filePath: 'c:/proj/.claude/skills/plan/SKILL.md' }),
          file({ name: 'SKILL.md', filePath: 'c:/proj/.claude/skills/verify/SKILL.md' }),
        ],
      }),
    );
    expect(html).toContain('plan/SKILL.md');
    expect(html).toContain('verify/SKILL.md');
  });

  it('handles a windows path', () => {
    const html = render(
      agent({ loadedFiles: [file({ name: 'SKILL.md', filePath: 'c:\\proj\\skills\\bug-tracker\\SKILL.md' })] }),
    );
    expect(html).toContain('bug-tracker/SKILL.md');
  });

  it('leaves an ordinary file alone', () => {
    const html = render(
      agent({ loadedFiles: [file({ name: 'AGENTS.md', filePath: 'c:/proj/AGENTS.md', category: 'unknown' })] }),
    );
    // The link TEXT is the bare name; the full path still belongs in the
    // tooltip, so this asserts on the label rather than on the whole document.
    expect(html).toContain('>AGENTS.md</a>');
    expect(html).not.toContain('>proj/AGENTS.md</a>');
  });

  it('falls back to the bare name when no path is known', () => {
    // The Claude path already reports a skill by its own name and no path.
    const html = render(agent({ loadedFiles: [file({ name: 'dataviz' })] }));
    expect(html).toContain('dataviz');
  });

  it('does not invent a folder for a path with no parent', () => {
    const html = render(agent({ loadedFiles: [file({ name: 'SKILL.md', filePath: 'SKILL.md' })] }));
    expect(html).toContain('SKILL.md');
    expect(html).not.toContain('/SKILL.md');
  });
});

describe('explaining an oversized file', () => {
  const oversized = file({
    name: 'AGENTS.md',
    filePath: 'c:/proj/AGENTS.md',
    category: 'unknown',
    estimatedTokens: 6413,
    charCount: 25_652,
  });

  it('says how far over the guideline it is', () => {
    const html = render(agent({ loadedFiles: [oversized], oversizedFiles: [oversized] }));
    expect(html).toContain('3.2×');
    expect(html).toContain('2,000-token guideline');
  });

  it('states the cost, so the warning is actionable rather than a scold', () => {
    const html = render(agent({ loadedFiles: [oversized], oversizedFiles: [oversized] }));
    expect(html).toContain('every turn');
    expect(html).toContain(String(OVERSIZED_THRESHOLD_TOKENS).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  });

  it('rounds off the decimal once a file is wildly over', () => {
    const huge = { ...oversized, estimatedTokens: 30_000 };
    const html = render(agent({ loadedFiles: [huge], oversizedFiles: [huge] }));
    expect(html).toContain('15×');
  });

  it('says nothing when nothing is oversized', () => {
    expect(render(agent({}))).not.toContain('Oversized context files');
  });
});

describe('collapseRepeatedSeparators', () => {
  it('collapses separators left doubled by JSON escaping', () => {
    expect(collapseRepeatedSeparators('c:\\\\Projects\\\\app\\\\SKILL.md')).toBe(
      'c:\\Projects\\app\\SKILL.md',
    );
  });

  it('leaves an already-clean path untouched', () => {
    expect(collapseRepeatedSeparators('c:\\Projects\\app')).toBe('c:\\Projects\\app');
  });

  it('preserves the leading pair of a UNC path', () => {
    // \\wsl$\Ubuntu\home is a real location; collapsing its prefix breaks it.
    expect(collapseRepeatedSeparators('\\\\wsl$\\\\Ubuntu\\\\home')).toBe('\\\\wsl$\\Ubuntu\\home');
  });

  it('leaves forward-slash paths alone', () => {
    expect(collapseRepeatedSeparators('/home/user/skills/plan/SKILL.md')).toBe(
      '/home/user/skills/plan/SKILL.md',
    );
  });
});
