import { describe, expect, it } from 'vitest';
import type { RepositoryDigestInput } from '../../../../shared/rpc';
import { renderDigest } from './digest';

const input: RepositoryDigestInput = {
  repository: 'https://github.com/o/repo',
  windowDays: 30,
  generatedAtMs: 0,
  sessions: {
    total: 4,
    previousTotal: 2,
    bySource: [{ source: 'claude', sessions: 4 }],
    verdicts: { smooth: 2, bumpy: 1, struggled: 1, abandoned: 0, unjudged: 0 },
    previousVerdicts: { smooth: 1, bumpy: 1, struggled: 0, abandoned: 0, unjudged: 0 },
  },
  themes: [
    { signalId: 'correction-reprompt', label: 'correction-reprompt', sessions: 2, previousSessions: 1, occurrences: 3 },
  ],
  tips: [{ id: 'state-expected-outcome', text: 'State the end state.', sessions: 2 }],
  hotspots: [
    { path: 'AGENTS.md', category: 'instruction', sessionCount: 4, appliedCount: 4, skippedCount: 0, estTokensMax: 900 },
  ],
  models: [{ model: 'claude-opus', sessions: 4, costMicros: 1_200_000 }],
  tokens: { inputTokens: 10_000, outputTokens: 2_000, cachedTokens: 500, costMicros: 1_200_000, costSessions: 4 },
  contextFiles: [
    { relPath: 'AGENTS.md', kind: 'memory', agent: 'shared', estTokens: 900, seenInSessions: 4, skippedCount: 0 },
  ],
};

describe('renderDigest', () => {
  it('renders Markdown with the renderer’s theme wording in place of signal ids', () => {
    const markdown = renderDigest(input);
    expect(markdown).toContain('# What agents learned in https://github.com/o/repo (last 30 days)');
    expect(markdown).toContain('Correction re-prompts');
    expect(markdown).not.toContain('correction-reprompt');
    expect(markdown).toContain('State the end state.');
    expect(markdown).toContain('AGENTS.md');
  });

  it('carries no absolute paths or branch names: the input has none and none are added', () => {
    const markdown = renderDigest(input);
    expect(markdown).not.toMatch(/[A-Za-z]:\\/);
    expect(markdown).not.toContain('/home/');
  });
});
