import { describe, expect, it } from 'vitest';
import { buttonLabel, matchSessions, planChatResponse } from './chatResponsePlan';
import { SessionSummary } from '../telemetry/models';
import type { Result } from '../telemetry/telemetryService';

/** Build a minimal SessionSummary; only the fields the chat helpers read matter. */
function session(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    sessionId: 'abcd1234-0000-0000-0000-000000000000',
    repository: 'github.com/acme/app',
    startedAtMs: 0,
    endedAtMs: 0,
    durationMs: 0,
    interactionCount: 0,
    llmCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    model: 'unknown',
    agentModes: [],
    ...overrides,
  };
}

const ok = (value: SessionSummary[]): Result<SessionSummary[]> => ({ ok: true, value });

describe('matchSessions', () => {
  const sessions = [
    session({ sessionId: 'aaaa1111-x', title: 'Refactor the parser' }),
    session({ sessionId: 'bbbb2222-x', title: 'Fix login bug' }),
    session({ sessionId: 'cccc3333-x', title: 'Update deps' }),
  ];

  it('returns every session for an empty query', () => {
    expect(matchSessions(sessions, '')).toHaveLength(3);
    expect(matchSessions(sessions, '   ')).toHaveLength(3);
  });

  it('matches on the session id, case-insensitively', () => {
    const result = matchSessions(sessions, 'CCCC');
    expect(result).toHaveLength(1);
    expect(result[0].sessionId).toBe('cccc3333-x');
  });

  it('matches on the local title, case-insensitively', () => {
    const result = matchSessions(sessions, 'login');
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe('Fix login bug');
  });

  it('returns nothing when neither id nor title matches', () => {
    expect(matchSessions(sessions, 'nonexistent')).toHaveLength(0);
  });
});

describe('buttonLabel', () => {
  it('uses the local title', () => {
    expect(buttonLabel(session({ title: 'Refactor the parser' }))).toBe('Open: Refactor the parser');
  });

  it('truncates a long title with an ellipsis', () => {
    const label = buttonLabel(session({ title: 'x'.repeat(60) }));
    expect(label.startsWith('Open: ')).toBe(true);
    expect(label.endsWith('…')).toBe(true);
    expect(label.length).toBeLessThan('Open: '.length + 60);
  });
});

describe('planChatResponse', () => {
  it('surfaces a read failure without buttons', () => {
    const plan = planChatResponse({ ok: false, reason: 'missingDb', message: 'DB not found.' }, '');
    expect(plan.buttons).toHaveLength(0);
    expect(plan.markdown).toContain('DB not found.');
  });

  it('reports the empty state when there are no sessions', () => {
    const plan = planChatResponse(ok([]), '');
    expect(plan.buttons).toHaveLength(0);
    expect(plan.markdown).toMatch(/no local copilot agent sessions/i);
  });

  it('reports the empty state when every session has an unknown repository', () => {
    const plan = planChatResponse(
      ok([
        session({ sessionId: 'a-1', title: 'One', repository: 'unknown' }),
        session({ sessionId: 'b-2', title: 'Two', repository: 'unknown' }),
      ]),
      '',
    );
    expect(plan.buttons).toHaveLength(0);
    expect(plan.markdown).toMatch(/no sessions with a known repository/i);
  });

  it('lists recent sessions as buttons, most-recently-active first', () => {
    const plan = planChatResponse(
      ok([
        session({ sessionId: 'mid', title: 'Mid', endedAtMs: 200 }),
        session({ sessionId: 'newest', title: 'Newest', endedAtMs: 300 }),
        session({ sessionId: 'oldest', title: 'Oldest', endedAtMs: 100 }),
      ]),
      '',
    );
    expect(plan.markdown).toMatch(/most recent/i);
    expect(plan.buttons).toEqual([
      { sessionId: 'newest', title: 'Open: Newest' },
      { sessionId: 'mid', title: 'Open: Mid' },
      { sessionId: 'oldest', title: 'Open: Oldest' },
    ]);
  });

  it('excludes unknown-repository sessions from the recent list', () => {
    const plan = planChatResponse(
      ok([
        session({ sessionId: 'known', title: 'Known repo', repository: 'github.com/acme/app' }),
        session({ sessionId: 'unknown-repo', title: 'No repo', repository: 'unknown' }),
      ]),
      '',
    );
    expect(plan.buttons.map((b) => b.sessionId)).toEqual(['known']);
  });

  it('filters to matching sessions for a query', () => {
    const plan = planChatResponse(
      ok([
        session({ sessionId: 'a-1', title: 'Fix login' }),
        session({ sessionId: 'b-2', title: 'Parser' }),
      ]),
      'login',
    );
    expect(plan.buttons).toHaveLength(1);
    expect(plan.buttons[0]).toEqual({ sessionId: 'a-1', title: 'Open: Fix login' });
    expect(plan.markdown).toMatch(/matching/i);
  });

  it('hints when a query matches nothing', () => {
    const plan = planChatResponse(ok([session({ sessionId: 'a-1', title: 'Parser' })]), 'zzz');
    expect(plan.buttons).toHaveLength(0);
    expect(plan.markdown).toContain('zzz');
  });

  it('caps matching-query buttons at the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => session({ sessionId: `s-${i}`, title: `Match ${i}` }));
    const plan = planChatResponse(ok(many), 'match');
    expect(plan.buttons).toHaveLength(5);
  });

  it('caps the recent-session buttons at the limit on the default path', () => {
    const many = Array.from({ length: 12 }, (_, i) => session({ sessionId: `s-${i}`, title: `S${i}` }));
    const plan = planChatResponse(ok(many), '');
    expect(plan.buttons).toHaveLength(5);
  });
});
