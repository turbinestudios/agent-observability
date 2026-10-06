import { describe, expect, it } from 'vitest';
import type { HandoffBrief, ReviewPacket, ReviewPacketResult } from '../../../../shared/rpc';
import {
  PR_BODY_LIMIT,
  REVIEWER_PREFILL,
  canResumeInTerminal,
  charCountLabel,
  packetStats,
  redactionLabel,
  renderHandoff,
  renderPacket,
  totalRedactions,
} from './packet';
import { packetState, refsFromKeys } from './selection';

function packet(over: Partial<ReviewPacket> = {}): ReviewPacket {
  return {
    source: 'claude',
    sessionId: 'sess-1',
    repository: 'https://github.com/o/repo',
    title: 'Fix the login test',
    goal: { text: 'Fix the flaky login test', fromPrompt: true },
    turns: [{ index: 0, line: 'Please fix the flaky login test', outcome: 'ok' }],
    turnsOmitted: 0,
    files: [
      { path: 'src/login.ts', insideRepo: true, linesAdded: 4, linesRemoved: 1, edits: 2, reEdits: 1, turns: 1, firstTurn: 0, lastTurn: 0 },
    ],
    filesOmitted: 0,
    filesAvailable: true,
    commands: [{ class: 'test', runs: 2, failures: 1 }],
    verification: { status: 'not-checked', testRuns: 2, testFailures: 1, checks: [] },
    deadEnds: [],
    risks: [],
    risksOmitted: 0,
    subAgents: [],
    models: [{ model: 'model-a', inputTokens: 1200, outputTokens: 300 }],
    totals: { inputTokens: 1200, outputTokens: 300, cachedTokens: 0, costMicros: 120_000, durationMs: 600_000, turns: 1 },
    costMode: 'usd',
    verdict: 'bumpy',
    outcome: 'partially',
    findings: [],
    tips: [],
    redactions: 2,
    ...over,
  };
}

const result: ReviewPacketResult = { packets: [packet()], skipped: [] };

describe('renderPacket', () => {
  it('renders Markdown and drops the request lines when asked to', () => {
    const withPrompts = renderPacket(result, { includePrompts: true });
    expect(withPrompts).toContain('Please fix the flaky login test');
    expect(withPrompts).toContain('src/login.ts');
    const without = renderPacket(result, { includePrompts: false });
    expect(without).not.toContain('Please fix the flaky login test');
    expect(without).toContain('src/login.ts');
  });

  it('is empty when no session could be read', () => {
    expect(renderPacket({ packets: [], skipped: [] }, { includePrompts: true })).toBe('');
  });
});

describe('stats and labels', () => {
  it('flags a packet longer than a pull request body allows', () => {
    expect(packetStats('abc')).toEqual({ chars: 3, overPrLimit: false });
    expect(packetStats('x'.repeat(PR_BODY_LIMIT + 1)).overPrLimit).toBe(true);
  });

  it('formats counts by hand', () => {
    expect(charCountLabel(1)).toBe('1 character');
    expect(charCountLabel(12345)).toBe('12,345 characters');
    expect(redactionLabel(0)).toBeUndefined();
    expect(redactionLabel(1)).toBe('1 secret-looking string was replaced.');
    expect(redactionLabel(3)).toBe('3 secret-looking strings were replaced.');
    expect(totalRedactions({ packets: [packet(), packet({ redactions: 1 })], skipped: [] })).toBe(3);
  });

  it('keeps the AI Helper door a fixed question', () => {
    expect(REVIEWER_PREFILL).toContain('Summarize this session');
    expect(REVIEWER_PREFILL).not.toContain('login');
  });

  it('offers a terminal resume only for the two CLI sources', () => {
    expect(canResumeInTerminal('claude')).toBe(true);
    expect(canResumeInTerminal('copilot-cli')).toBe(true);
    expect(canResumeInTerminal('copilot')).toBe(false);
  });
});

describe('renderHandoff', () => {
  it('renders the brief with the suggested prompt and no cost section', () => {
    const brief: HandoffBrief = {
      source: 'claude',
      sessionId: 'sess-1',
      repository: 'https://github.com/o/repo',
      goal: 'Fix the flaky login test',
      state: { turns: 3, ending: 'interrupted', lastRequest: 'Try again without mocks', lastTurnFailed: false, filesChanged: 1 },
      constraints: [{ turnIndex: 0, text: 'Never touch the public API.', kind: 'constraint' }],
      files: [{ path: 'src/login.ts', insideRepo: true, edits: 2, lastTurn: 2 }],
      verified: [],
      notVerified: ['No check ran after the last edit.'],
      openItems: [{ text: 'Re-run the login test', origin: 'last-reply' }],
      contextFiles: ['AGENTS.md'],
      suggestedPrompt: 'Continue fixing the flaky login test. Read src/login.ts first.',
      redactions: 0,
    };
    const markdown = renderHandoff(brief);
    expect(markdown).toContain('Never touch the public API.');
    expect(markdown).toContain('Continue fixing the flaky login test');
    expect(markdown).not.toMatch(/\$\d/);
  });
});

describe('packet selection', () => {
  it('allows a packet from one ticked session and caps the count', () => {
    expect(packetState([])).toEqual({ canBuild: false });
    expect(packetState(['claude:a'])).toEqual({ canBuild: true });
    expect(packetState(Array.from({ length: 11 }, (_, i) => `claude:${i}`)).canBuild).toBe(false);
  });

  it('turns keys back into refs, keeping colons inside a session id', () => {
    expect(refsFromKeys(['claude:abc', 'copilot-cli:x:y', 'broken', ':nope'])).toEqual([
      { source: 'claude', sessionId: 'abc' },
      { source: 'copilot-cli', sessionId: 'x:y' },
    ]);
  });
});
