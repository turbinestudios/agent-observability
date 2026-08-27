import { describe, it, expect } from 'vitest';
import {
  CHAT_SESSION_CANDIDATES_SQL,
  CONVERSATION_ONLY_CANDIDATES_SQL,
  SESSION_KEY_EXPR,
  UUID_RE,
  startedSessionSet,
  suggestionOnlySql,
} from './sessionFilter';

/**
 * This filter decides what a user sees in their session list. Without it, one
 * real machine showed 435 rows for 47 actual sessions — tool-call ids and
 * chat-helper traffic drowning the work. Both the extension and the desktop app
 * depend on it producing identical sets.
 */

function keys(...values: string[]): { session_key: string }[] {
  return values.map((session_key) => ({ session_key }));
}

const UUID_A = '29c51380-7b4c-4606-917b-ff3f03005d2f';
const UUID_B = '3b2196c7-b969-4a8e-8ebc-3b84af42f752';

describe('UUID_RE', () => {
  it('accepts a bare UUID in either case', () => {
    expect(UUID_RE.test(UUID_A)).toBe(true);
    expect(UUID_RE.test(UUID_A.toUpperCase())).toBe(true);
  });

  it('rejects tool-call and sub-agent ids that also land in chat_session_id', () => {
    expect(UUID_RE.test('toolu_01MtZjSgV8fWBuVz42xMJgAd')).toBe(false);
    expect(UUID_RE.test('toolu_bdrk_01ABCDEF')).toBe(false);
    expect(UUID_RE.test(`call_${UUID_A}`)).toBe(false);
  });

  it('rejects a UUID with anything around it, so a prefixed key cannot slip through', () => {
    expect(UUID_RE.test(`claude-code:/${UUID_A}`)).toBe(false);
    expect(UUID_RE.test(`${UUID_A} `)).toBe(false);
  });
});

describe('startedSessionSet', () => {
  it('keeps UUID-shaped chat sessions', () => {
    expect([...startedSessionSet(keys(UUID_A, UUID_B), [])]).toEqual([UUID_A, UUID_B]);
  });

  it('drops non-UUID keys from either candidate list', () => {
    const started = startedSessionSet(
      keys(UUID_A, 'toolu_01MtZjSgV8fWBuVz42xMJgAd'),
      keys('not-a-uuid'),
    );
    expect([...started]).toEqual([UUID_A]);
  });

  it('merges both shapes without duplicating a key present in each', () => {
    expect(startedSessionSet(keys(UUID_A), keys(UUID_A, UUID_B)).size).toBe(2);
  });

  it('excludes suggestion-only chat sessions', () => {
    const started = startedSessionSet(keys(UUID_A, UUID_B), [], new Set([UUID_A]));
    expect([...started]).toEqual([UUID_B]);
  });

  it('applies the conversation-shape exclusion to its own key only', () => {
    // A key excluded as a chat session must not be excluded as a conversation
    // one; the two shapes group differently and are filtered independently.
    const started = startedSessionSet(keys(UUID_A), keys(UUID_B), new Set([UUID_A]), new Set());
    expect([...started]).toEqual([UUID_B]);
  });

  it('admits everything when no exclusions are supplied', () => {
    expect(startedSessionSet(keys(UUID_A), keys(UUID_B)).size).toBe(2);
  });

  it('returns an empty set for no candidates', () => {
    expect(startedSessionSet([], []).size).toBe(0);
  });
});

describe('SQL fragments', () => {
  it('groups by the same key expression the sessions view uses', () => {
    expect(SESSION_KEY_EXPR).toBe('COALESCE(conversation_id, chat_session_id)');
    expect(CONVERSATION_ONLY_CANDIDATES_SQL).toContain(SESSION_KEY_EXPR);
  });

  it('selects a consistently named column, which callers destructure', () => {
    for (const sql of [
      CHAT_SESSION_CANDIDATES_SQL,
      CONVERSATION_ONLY_CANDIDATES_SQL,
      suggestionOnlySql('chat_session_id'),
    ]) {
      expect(sql).toContain('AS session_key');
    }
  });

  it('bounds candidates to UUID length before the regex runs', () => {
    // The length check is what keeps the row set small enough to filter in code.
    expect(CHAT_SESSION_CANDIDATES_SQL).toContain('LENGTH(chat_session_id) = 36');
    expect(CONVERSATION_ONLY_CANDIDATES_SQL).toContain('= 36');
  });

  it('requires an agent-run span for conversation-only sessions', () => {
    // Chat helpers produce chat spans but never invoke an agent or run a tool;
    // dropping this clause is what floods the list.
    expect(CONVERSATION_ONLY_CANDIDATES_SQL).toContain('invoke_agent');
    expect(CONVERSATION_ONLY_CANDIDATES_SQL).toContain('execute_tool');
    expect(CONVERSATION_ONLY_CANDIDATES_SQL).toContain('execute_hook');
  });

  it('excludes conversation-only keys that carry any chat_session_id', () => {
    expect(CONVERSATION_ONLY_CANDIDATES_SQL).toMatch(/chat_session_id IS NOT NULL[\s\S]*= 0/);
  });

  it('interpolates the key expression it is given', () => {
    expect(suggestionOnlySql('chat_session_id')).toContain('chat_session_id AS session_key');
    expect(suggestionOnlySql(SESSION_KEY_EXPR)).toContain(`${SESSION_KEY_EXPR} AS session_key`);
  });

  it('treats a session as suggestion-only when no non-suggestion model appears', () => {
    expect(suggestionOnlySql('chat_session_id')).toContain("NOT LIKE '%suggestions%'");
  });
});
