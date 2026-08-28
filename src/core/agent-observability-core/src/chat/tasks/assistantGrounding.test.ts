import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_QUICK_PROMPTS,
  CORPUS_SESSION_LIMIT,
  buildAssistantPreamble,
  buildSessionRefMap,
  type AssistantSessionRow,
} from './assistantGrounding';

function row(overrides: Partial<AssistantSessionRow> = {}): AssistantSessionRow {
  return {
    ref: 'S1',
    source: 'claude',
    sessionId: 'abc-123',
    title: 'Fix the login bug',
    repository: 'github.com/acme/app',
    startedAtMs: Date.UTC(2026, 7, 28, 14, 5),
    durationMs: 45 * 60_000,
    interactionCount: 12,
    toolCalls: 34,
    inputTokens: 120_000,
    outputTokens: 8_000,
    model: 'sonnet',
    verdict: 'smooth',
    costMicros: 420_000,
    ...overrides,
  };
}

const NOW = Date.UTC(2026, 7, 28, 16, 0);

describe('buildAssistantPreamble', () => {
  it('grounds the model in instructions, the current time, and the session lines', () => {
    const preamble = buildAssistantPreamble([row()], undefined, false, NOW);
    expect(preamble).toContain('Current time: 2026-08-28T16:00:00.000Z');
    expect(preamble).toContain('# Recent sessions (newest first)');
    expect(preamble).toContain('[S1]');
    expect(preamble).toContain('Cite sessions by their bracketed ref');
  });

  it('carries titles, repositories, verdicts, and cost — decision 2 is the contract', () => {
    // The safe-metadata projection in logSummary.ts deliberately OMITS titles;
    // the desktop AI Helper deliberately INCLUDES them (sanctioned exception,
    // AGENTS.md). If this assertion starts failing because someone re-sanitized
    // the preamble, that is a product decision to revisit, not a bug fix.
    const preamble = buildAssistantPreamble([row()], undefined, false, NOW);
    expect(preamble).toContain('"Fix the login bug"');
    expect(preamble).toContain('github.com/acme/app');
    expect(preamble).toContain('smooth');
    expect(preamble).toContain('$0.42');
    expect(preamble).toContain('120.0k in / 8.0k out tokens');
  });

  it('includes the focus session digest under its ref', () => {
    const focus = { row: row({ ref: 'S3', title: 'Refactor auth' }), digest: ['## Turn 1', 'Developer asked: hi'] };
    const preamble = buildAssistantPreamble([row()], focus, false, NOW);
    expect(preamble).toContain('# Focus session [S3]');
    expect(preamble).toContain('Developer asked: hi');
  });

  it('notes truncated history so the model does not hallucinate continuity', () => {
    const preamble = buildAssistantPreamble([row()], undefined, true, NOW);
    expect(preamble).toContain('omitted for length');
  });

  it('says so when no sessions are indexed', () => {
    const preamble = buildAssistantPreamble([], undefined, false, NOW);
    expect(preamble).toContain('(no sessions indexed yet)');
  });

  it('totals the listed sessions', () => {
    const preamble = buildAssistantPreamble([row(), row({ ref: 'S2', costMicros: 580_000 })], undefined, false, NOW);
    expect(preamble).toContain('2 sessions');
    expect(preamble).toContain('$1.00 total cost');
  });
});

describe('buildSessionRefMap', () => {
  it('maps refs to sessions with the title as the label', () => {
    const map = buildSessionRefMap([row()]);
    expect(map.get('S1')).toEqual({ source: 'claude', sessionId: 'abc-123', label: 'Fix the login bug' });
  });

  it('falls back to the ref when a session has no title', () => {
    const map = buildSessionRefMap([row({ title: undefined })]);
    expect(map.get('S1')?.label).toBe('S1');
  });

  it('includes the focus session', () => {
    const focus = { row: row({ ref: 'S9', sessionId: 'zzz' }), digest: [] };
    const map = buildSessionRefMap([row()], focus);
    expect(map.get('S9')?.sessionId).toBe('zzz');
  });
});

describe('quick prompts and limits', () => {
  it('every quick prompt has a non-empty prompt and a unique id', () => {
    const ids = new Set(ASSISTANT_QUICK_PROMPTS.map((p) => p.id));
    expect(ids.size).toBe(ASSISTANT_QUICK_PROMPTS.length);
    for (const prompt of ASSISTANT_QUICK_PROMPTS) {
      expect(prompt.prompt.trim().length).toBeGreaterThan(0);
      expect(prompt.label.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the corpus limit at a size the prompt budget was designed for', () => {
    expect(CORPUS_SESSION_LIMIT).toBeLessThanOrEqual(60);
  });
});
