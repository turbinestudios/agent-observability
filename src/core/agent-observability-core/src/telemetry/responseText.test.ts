import { describe, it, expect } from 'vitest';
import { extractResponseText } from './responseText';

/**
 * Extraction tests for the `gen_ai.output.messages` attribute. The extractor is
 * deliberately tolerant: it must surface readable assistant text across provider
 * shapes and degrade to the raw string (never throw) on anything unexpected.
 */
describe('extractResponseText', () => {
  it('extracts text from the parts[] message shape', () => {
    const raw = JSON.stringify([
      { role: 'assistant', parts: [{ type: 'text', content: 'Hello there.' }] },
    ]);
    expect(extractResponseText(raw)).toBe('Hello there.');
  });

  it('extracts a plain string content field', () => {
    const raw = JSON.stringify([{ role: 'assistant', content: 'Plain answer.' }]);
    expect(extractResponseText(raw)).toBe('Plain answer.');
  });

  it('joins multiple messages and skips non-text parts', () => {
    const raw = JSON.stringify([
      {
        role: 'assistant',
        parts: [
          { type: 'text', content: 'First.' },
          { type: 'tool_call', content: '{"name":"x"}' },
          { type: 'text', text: 'Second.' },
        ],
      },
      { role: 'assistant', content: 'Third.' },
    ]);
    expect(extractResponseText(raw)).toBe('First.\nSecond.\nThird.');
  });

  it('falls back to the trimmed raw string for the redacted fixture placeholder', () => {
    expect(extractResponseText('  [redacted:455] ')).toBe('[redacted:455]');
  });

  it('falls back to the raw string on malformed JSON', () => {
    expect(extractResponseText('{not json')).toBe('{not json');
  });

  it('falls back to the raw string when the array yields no text', () => {
    const raw = JSON.stringify([{ role: 'assistant', parts: [{ type: 'tool_call', content: '{}' }] }]);
    expect(extractResponseText(raw)).toBe(raw);
  });
});
