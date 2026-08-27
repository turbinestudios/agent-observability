import { describe, it, expect } from 'vitest';
import { claudeCostMicros, isKnownModel, microsToUsd, modelKey } from './pricing';

describe('modelKey', () => {
  it('strips a claude- prefix and a date snapshot suffix', () => {
    expect(modelKey('claude-haiku-4-5-20251001')).toBe('haiku-4-5');
    expect(modelKey('claude-opus-4-7')).toBe('opus-4-7');
    expect(modelKey('CLAUDE-Sonnet-4-6')).toBe('sonnet-4-6');
  });
});

describe('claudeCostMicros', () => {
  it('prices input/output/cache-read/cache-write at the published rates', () => {
    // opus: $5/MTok input, $25/MTok output; cache read 0.1×, cache write 1.25×.
    const micros = claudeCostMicros('claude-opus-4-7', {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    });
    // (10*5 + 20*25 + 100*5*0.1 + 50*5*1.25) = 912.5 micro-USD, rounded to 913.
    expect(micros).toBe(913);
    expect(microsToUsd(micros)).toBeCloseTo(0.000913, 9);
  });

  it('uses haiku rates for haiku models', () => {
    // haiku: $1/$5; (3*1 + 4*5 + 10*1*0.1)/1e6 = 24 micro-USD.
    expect(claudeCostMicros('claude-haiku-4-5', {
      input_tokens: 3,
      output_tokens: 4,
      cache_read_input_tokens: 10,
    })).toBe(24);
  });

  it('returns 0 for an unknown model or missing usage', () => {
    expect(claudeCostMicros('gpt-4o', { input_tokens: 1000, output_tokens: 1000 })).toBe(0);
    expect(claudeCostMicros('claude-opus-4-7', undefined)).toBe(0);
  });

  it('falls back to the family rate for an unenumerated minor version', () => {
    // A hypothetical future opus minor still prices at the opus family rate.
    expect(claudeCostMicros('claude-opus-4-99', { output_tokens: 1_000_000 })).toBe(25_000_000);
  });
});

describe('isKnownModel', () => {
  it('recognizes current families and rejects non-Claude models', () => {
    expect(isKnownModel('claude-sonnet-4-6')).toBe(true);
    expect(isKnownModel('claude-fable-5')).toBe(true);
    expect(isKnownModel('gpt-4o')).toBe(false);
    expect(isKnownModel(undefined)).toBe(false);
  });
});
