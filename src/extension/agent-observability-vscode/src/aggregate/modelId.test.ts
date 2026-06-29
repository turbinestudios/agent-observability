import { describe, it, expect } from 'vitest';
import { sanitizeModelId, UNKNOWN_MODEL } from './modelId';

/**
 * The server's model regex is `^[A-Za-z0-9._:\-/]+$` (max 128). Every output of
 * sanitizeModelId MUST satisfy it — these tests pin that guarantee plus the
 * information-preserving behaviour for real display names.
 */
const SERVER_MODEL_REGEX = /^[A-Za-z0-9._:\-/]+$/;

describe('sanitizeModelId', () => {
  it('passes clean ids through verbatim', () => {
    for (const id of ['gpt-4.1', 'claude-opus-4-6', 'openai/gpt-4o', 'o3-mini', 'unknown']) {
      expect(sanitizeModelId(id)).toBe(id);
    }
  });

  it('collapses spaces and parentheses in display names to a safe id', () => {
    expect(sanitizeModelId('Claude Sonnet 4.5')).toBe('Claude-Sonnet-4.5');
    expect(sanitizeModelId('GPT-4o (Preview)')).toBe('GPT-4o-Preview');
  });

  it("strips Claude Code's <synthetic> placeholder (the real-world 400 culprit)", () => {
    // Claude Code marks non-model assistant entries with model "<synthetic>";
    // the angle brackets fail the server regex and 400'd the whole batch.
    expect(sanitizeModelId('<synthetic>')).toBe('synthetic');
  });

  it('trims leading/trailing separator noise the collapse introduces', () => {
    expect(sanitizeModelId('  spaced model  ')).toBe('spaced-model');
    expect(sanitizeModelId('(o1)')).toBe('o1');
  });

  it('maps blank / null / undefined / info-free input to unknown', () => {
    expect(sanitizeModelId('')).toBe(UNKNOWN_MODEL);
    expect(sanitizeModelId('   ')).toBe(UNKNOWN_MODEL);
    expect(sanitizeModelId(null)).toBe(UNKNOWN_MODEL);
    expect(sanitizeModelId(undefined)).toBe(UNKNOWN_MODEL);
    expect(sanitizeModelId('()!!')).toBe(UNKNOWN_MODEL);
  });

  it('caps the output at 128 characters', () => {
    const out = sanitizeModelId('m'.repeat(200));
    expect(out).toHaveLength(128);
  });

  it('always produces a value the server regex accepts', () => {
    const inputs = [
      'Claude Sonnet 4.5',
      'GPT-4o (Preview)',
      'модель',
      'a@b#c?d',
      'name with\ttabs\nand newlines',
      'emoji 🤖 model',
      'x'.repeat(300),
      '',
      '   ',
    ];
    for (const input of inputs) {
      const out = sanitizeModelId(input);
      expect(out.length).toBeGreaterThan(0);
      expect(out.length).toBeLessThanOrEqual(128);
      expect(SERVER_MODEL_REGEX.test(out)).toBe(true);
    }
  });
});
