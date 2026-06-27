import { describe, it, expect } from 'vitest';
import { Conversation, assembleMessages } from './conversation';

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
