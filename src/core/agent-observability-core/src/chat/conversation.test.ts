import { describe, it, expect } from 'vitest';
import { Conversation, assembleMessages, truncateHistory } from './conversation';

describe('Conversation', () => {
  it('starts empty and records turns in order', () => {
    const c = new Conversation();
    expect(c.isEmpty()).toBe(true);
    c.append('user', 'hi');
    c.append('assistant', 'hello');
    expect(c.isEmpty()).toBe(false);
    expect(c.history).toEqual([
      { role: 'user', text: 'hi' },
      { role: 'assistant', text: 'hello' },
    ]);
  });

  it('ignores empty/whitespace turns', () => {
    const c = new Conversation();
    c.append('user', '   ');
    c.append('assistant', '');
    expect(c.isEmpty()).toBe(true);
  });

  it('clear() resets the transcript', () => {
    const c = new Conversation();
    c.append('user', 'hi');
    c.clear();
    expect(c.isEmpty()).toBe(true);
    expect(c.history).toEqual([]);
  });

  it('history is a snapshot, not a live reference', () => {
    const c = new Conversation();
    c.append('user', 'hi');
    const snap = c.history;
    c.append('assistant', 'later');
    expect(snap).toHaveLength(1);
  });
});

describe('truncateHistory', () => {
  it('returns everything untouched while under the budget', () => {
    const history = [
      { role: 'user' as const, text: 'q1' },
      { role: 'assistant' as const, text: 'a1' },
    ];
    expect(truncateHistory(history, 100)).toEqual({ history, truncated: false });
  });

  it('drops whole oldest turns first and flags the truncation', () => {
    const history = [
      { role: 'user' as const, text: 'x'.repeat(50) },
      { role: 'assistant' as const, text: 'y'.repeat(50) },
      { role: 'user' as const, text: 'z'.repeat(50) },
    ];
    const result = truncateHistory(history, 120);
    expect(result.truncated).toBe(true);
    expect(result.history).toEqual(history.slice(1));
  });

  it('always keeps the newest turn, even alone over budget', () => {
    const history = [
      { role: 'user' as const, text: 'old' },
      { role: 'user' as const, text: 'n'.repeat(500) },
    ];
    const result = truncateHistory(history, 100);
    expect(result.history).toEqual([history[1]]);
    expect(result.truncated).toBe(true);
  });

  it('handles an empty history', () => {
    expect(truncateHistory([], 100)).toEqual({ history: [], truncated: false });
  });
});

describe('assembleMessages', () => {
  it('prepends the preamble as a leading user turn, then history in order', () => {
    const messages = assembleMessages('PREAMBLE', [
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'a' },
    ]);
    expect(messages).toEqual([
      { role: 'user', text: 'PREAMBLE' },
      { role: 'user', text: 'q' },
      { role: 'assistant', text: 'a' },
    ]);
  });
});
