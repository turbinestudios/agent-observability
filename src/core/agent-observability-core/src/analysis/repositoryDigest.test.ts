import { describe, expect, it } from 'vitest';
import {
  buildRepositoryDigest,
  formatUsd,
  percent,
  renderRepositoryDigestMarkdown,
  trendLabel,
  type RepositoryDigestInput,
} from './repositoryDigest';

function input(overrides: Partial<RepositoryDigestInput> = {}): RepositoryDigestInput {
  return {
    repository: 'https://github.com/acme/widgets',
    windowDays: 30,
    generatedAtMs: 0,
    sessions: {
      total: 0,
      previousTotal: 0,
      bySource: [],
      verdicts: { smooth: 0, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0 },
      previousVerdicts: { smooth: 0, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0 },
    },
    themes: [],
    tips: [],
    hotspots: [],
    models: [],
    tokens: { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costMicros: 0, costSessions: 0 },
    contextFiles: [],
    ...overrides,
  };
}

function section(digest: ReturnType<typeof buildRepositoryDigest>, title: string): string[] {
  const found = digest.sections.find((s) => s.title === title);
  if (found === undefined) {
    throw new Error(`missing section ${title}`);
  }
  return found.lines;
}

describe('buildRepositoryDigest', () => {
  it('renders "(none yet)" in every section for an empty window', () => {
    const digest = buildRepositoryDigest(input());
    expect(digest.headline).toBe('What agents learned in https://github.com/acme/widgets (last 30 days)');
    for (const s of digest.sections) {
      expect(s.lines).toEqual(['(none yet)']);
    }
  });

  it('computes verdict shares with rounding and a previous-window comparison', () => {
    const digest = buildRepositoryDigest(
      input({
        sessions: {
          total: 3,
          previousTotal: 5,
          bySource: [
            { source: 'claude', sessions: 2 },
            { source: 'copilot', sessions: 1 },
          ],
          verdicts: { smooth: 2, bumpy: 1, struggled: 0, abandoned: 0, unjudged: 0 },
          previousVerdicts: { smooth: 2, bumpy: 2, struggled: 1, abandoned: 0, unjudged: 0 },
        },
      }),
    );
    const lines = section(digest, 'How sessions went');
    expect(lines[0]).toBe('3 sessions (-2 sessions): 2 Claude Code, 1 Copilot');
    expect(lines[1]).toBe('Smooth 67% (was 40%): 2 sessions');
    expect(lines[2]).toBe('Bumpy 33% (was 40%): 1 session');
    expect(lines.length).toBe(3);
  });

  it('ranks themes and tips by sessions, caps them, and labels the trend', () => {
    const digest = buildRepositoryDigest(
      input({
        sessions: { ...input().sessions, total: 10 },
        themes: Array.from({ length: 7 }, (_, i) => ({
          signalId: `s${i}`,
          label: `Theme ${i}`,
          sessions: i + 1,
          previousSessions: i + 1,
          occurrences: (i + 1) * 2,
        })),
        tips: [
          { id: 'a', text: 'Tip A.', sessions: 1 },
          { id: 'b', text: 'Tip B.', sessions: 4 },
          { id: 'c', text: 'Tip C.', sessions: 3 },
          { id: 'd', text: 'Tip D.', sessions: 2 },
          { id: 'none', text: 'Never fired.', sessions: 0 },
        ],
      }),
    );
    const themes = section(digest, 'Recurring friction');
    expect(themes.length).toBe(5);
    expect(themes[0]).toBe('Theme 6: 7 sessions, 14 occurrences (no change)');
    const tips = section(digest, 'What usually helps here');
    expect(tips).toEqual(['Fired in 4 sessions. Tip B.', 'Fired in 3 sessions. Tip C.', 'Fired in 2 sessions. Tip D.']);
  });

  it('marks oversized hotspots and lists unused files on disk', () => {
    const digest = buildRepositoryDigest(
      input({
        hotspots: [
          { path: 'CLAUDE.md', category: 'instruction', sessionCount: 8, appliedCount: 6, skippedCount: 2, estTokensMax: 2500 },
          { path: '.github/skills/x/SKILL.md', category: 'skill', sessionCount: 1, appliedCount: 1, skippedCount: 0, estTokensMax: 120 },
        ],
        contextFiles: [
          { relPath: 'CLAUDE.md', kind: 'memory', agent: 'claude', estTokens: 600, seenInSessions: 8, skippedCount: 2 },
          { relPath: '.claude/rules/b.md', kind: 'rule', agent: 'claude', estTokens: 50, seenInSessions: 0, skippedCount: 0 },
          { relPath: '.claude/rules/a.md', kind: 'rule', agent: 'claude', estTokens: 40, seenInSessions: 0, skippedCount: 0 },
        ],
      }),
    );
    const hotspots = section(digest, 'Context files agents actually use');
    expect(hotspots[0]).toBe('`CLAUDE.md` (instruction): 8 sessions, 25% skipped, up to ~2,500 tokens, oversized');
    expect(hotspots[1]).toBe('`.github/skills/x/SKILL.md` (skill): 1 session, 0% skipped, up to ~120 tokens');
    const onDisk = section(digest, 'Context files on disk');
    expect(onDisk[0]).toBe('3 files on disk: 2 rule, 1 memory');
    expect(onDisk[1]).toBe('Unused by agents so far: `.claude/rules/a.md`, `.claude/rules/b.md`');
  });

  it('omits the tools lines when no tools are provided and includes them when sampled', () => {
    const base = input({ models: [{ model: 'claude-opus-5-5', sessions: 4, costMicros: 1_234_560_000 }] });
    const without = buildRepositoryDigest(base);
    expect(section(without, 'Models and tools')).toEqual(['claude-opus-5-5: 4 sessions, est. $1,234.56']);

    const withTools = buildRepositoryDigest({
      ...base,
      tools: [
        { name: 'Bash', calls: 1234, failures: 7, sampledSessions: 8 },
        { name: 'Read', calls: 900, failures: 0, sampledSessions: 8 },
      ],
    });
    const lines = section(withTools, 'Models and tools');
    expect(lines[1]).toBe('Tool Bash: 1,234 calls, 7 failed (sampled from the 8 most recent sessions)');
    expect(lines[2]).toBe('Tool Read: 900 calls (sampled from the 8 most recent sessions)');
  });

  it('drops the sample wording when the tool figures cover the whole window', () => {
    const digest = buildRepositoryDigest(input({ tools: [{ name: 'Bash', calls: 12, failures: 1 }] }));
    const lines = section(digest, 'Models and tools');
    expect(lines).toContain('Tool Bash: 12 calls, 1 failed');
    expect(lines.join(' ')).not.toContain('sampled');
  });

  it('reports spend with hand-grouped tokens and cost coverage', () => {
    const digest = buildRepositoryDigest(
      input({
        sessions: { ...input().sessions, total: 12 },
        tokens: { inputTokens: 1_234_567, outputTokens: 89_000, cachedTokens: 1_000_000, costMicros: 12_340_000, costSessions: 9 },
      }),
    );
    expect(section(digest, 'Spend')).toEqual([
      '1,234,567 input, 89,000 output, 1,000,000 cached tokens',
      'Est. $12.34 across 9 of 12 sessions priced',
    ]);
  });
});

describe('renderRepositoryDigestMarkdown', () => {
  it('emits a heading per section, bullets per line, the footer, and no absolute paths for relative inputs', () => {
    const digest = buildRepositoryDigest(
      input({
        hotspots: [{ path: '.github/copilot-instructions.md', category: 'instruction', sessionCount: 2, appliedCount: 2, skippedCount: 0, estTokensMax: 100 }],
        contextFiles: [{ relPath: 'AGENTS.md', kind: 'memory', agent: 'shared', estTokens: 10, seenInSessions: 1, skippedCount: 0 }],
      }),
    );
    const markdown = renderRepositoryDigestMarkdown(digest);
    expect(markdown.startsWith('# What agents learned in https://github.com/acme/widgets (last 30 days)\n\n## How sessions went\n\n- (none yet)\n')).toBe(true);
    expect(markdown).toContain('\n## Context files agents actually use\n\n- `.github/copilot-instructions.md`');
    expect(markdown.trimEnd().endsWith('_Generated locally by Agent Observability; no session content included._')).toBe(true);
    expect(markdown).not.toMatch(/[A-Za-z]:\\/);
    expect(markdown).not.toContain('/home/');
  });

  it('flattens labels so a theme label cannot break out of its bullet', () => {
    const digest = buildRepositoryDigest(
      input({
        sessions: { ...input().sessions, total: 1 },
        themes: [{ signalId: 'x', label: 'multi\nline `code`', sessions: 1, previousSessions: 0, occurrences: 1 }],
      }),
    );
    expect(section(digest, 'Recurring friction')[0]).toBe('multi line code: 1 session, 1 occurrence (+1 session)');
  });
});

describe('helpers', () => {
  it('trendLabel', () => {
    expect(trendLabel(5, 2, 'session')).toBe('+3 sessions');
    expect(trendLabel(1, 2, 'session')).toBe('-1 session');
    expect(trendLabel(2, 2, 'session')).toBe('no change');
    expect(trendLabel(1500, 0, 'session')).toBe('+1,500 sessions');
  });

  it('percent rounds and tolerates a zero denominator', () => {
    expect(percent(2, 3)).toBe(67);
    expect(percent(1, 3)).toBe(33);
    expect(percent(0, 0)).toBe(0);
  });

  it('formatUsd pads cents and groups dollars', () => {
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(5_000)).toBe('$0.01');
    expect(formatUsd(1_234_560_000)).toBe('$1,234.56');
  });
});
