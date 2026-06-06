import { describe, it, expect } from 'vitest';
import {
  normalizeModelId,
  rateForModel,
  computeCost,
  sumCost,
  parsePricingOverrides,
  ModelRate,
  ModelTokens,
  CostEstimate,
} from './pricing';

/** A model with zero tokens of every kind. */
const ZERO: ModelTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: 0,
  reasoningTokens: 0,
};

describe('normalizeModelId', () => {
  it('collapses the dotted request form and dashed response form to one id', () => {
    expect(normalizeModelId('claude-opus-4.6')).toBe('claude-opus-4-6');
    expect(normalizeModelId('claude-opus-4-6')).toBe('claude-opus-4-6');
    expect(normalizeModelId('claude-sonnet-4.6')).toBe('claude-sonnet-4-6');
  });

  it('strips a trailing -YYYY-MM-DD dated suffix', () => {
    expect(normalizeModelId('gpt-4o-mini-2024-07-18')).toBe('gpt-4o-mini');
    expect(normalizeModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
  });

  it('trims and lowercases', () => {
    expect(normalizeModelId('  Claude-Opus-4-6 ')).toBe('claude-opus-4-6');
  });

  it('passes through ids with no special shape', () => {
    expect(normalizeModelId('unknown')).toBe('unknown');
    expect(normalizeModelId('')).toBe('');
  });
});

describe('rateForModel', () => {
  const rates: Record<string, ModelRate> = {
    // Keyed in the dashed form; the dotted data id must still match.
    'claude-opus-4-6': { inputPerMTok: 15, outputPerMTok: 75 },
  };

  it('matches via normalization regardless of dot/dash form on either side', () => {
    expect(rateForModel('claude-opus-4.6', rates)).toBe(rates['claude-opus-4-6']);
    expect(rateForModel('claude-opus-4-6', rates)).toBe(rates['claude-opus-4-6']);
    // A key authored in the dotted form also matches a dashed data id.
    expect(rateForModel('claude-opus-4-6', { 'claude-opus-4.6': rates['claude-opus-4-6'] })).toBe(
      rates['claude-opus-4-6'],
    );
  });

  it('returns undefined when nothing matches', () => {
    expect(rateForModel('gpt-4o', rates)).toBeUndefined();
    expect(rateForModel('unknown', rates)).toBeUndefined();
  });
});

describe('computeCost', () => {
  const rate: Record<string, ModelRate> = {
    'm': { inputPerMTok: 10, outputPerMTok: 20 },
  };

  it('returns available:false (→ n/a) when no rate is configured', () => {
    expect(computeCost('m', { ...ZERO, inputTokens: 1_000_000 }, {})).toEqual({ available: false });
  });

  it('treats a known rate with zero tokens as a legitimate $0 (available:true)', () => {
    const c = computeCost('m', ZERO, rate);
    expect(c).toEqual({ available: true, inputUsd: 0, outputUsd: 0, totalUsd: 0 });
  });

  it('charges cached input at a discounted default of 0.1× the input rate', () => {
    // 1M input of which 1M cached → uncached 0; cached billed at 0.1×10 = 1.
    const c = computeCost(
      'm',
      { ...ZERO, inputTokens: 1_000_000, cachedTokens: 1_000_000 },
      rate,
    ) as Extract<CostEstimate, { available: true }>;
    expect(c.available).toBe(true);
    expect(c.inputUsd).toBeCloseTo(1, 9);
    expect(c.totalUsd).toBeCloseTo(1, 9);
  });

  it('bills uncached input at full rate and cached at the explicit cached rate', () => {
    // input 1M, cached 400k → uncached 600k at 10 = 6; cached 400k at 2 = 0.8.
    const c = computeCost(
      'm',
      { ...ZERO, inputTokens: 1_000_000, cachedTokens: 400_000 },
      { m: { inputPerMTok: 10, outputPerMTok: 20, cachedInputPerMTok: 2 } },
    ) as Extract<CostEstimate, { available: true }>;
    expect(c.inputUsd).toBeCloseTo(6.8, 9);
  });

  it('defaults reasoning tokens to the output rate, and honors an explicit reasoning rate', () => {
    const dflt = computeCost(
      'm',
      { ...ZERO, reasoningTokens: 1_000_000 },
      rate,
    ) as Extract<CostEstimate, { available: true }>;
    // reasoning billed at output rate 20.
    expect(dflt.outputUsd).toBeCloseTo(20, 9);

    const explicit = computeCost(
      'm',
      { ...ZERO, reasoningTokens: 1_000_000 },
      { m: { inputPerMTok: 10, outputPerMTok: 20, reasoningPerMTok: 5 } },
    ) as Extract<CostEstimate, { available: true }>;
    expect(explicit.outputUsd).toBeCloseTo(5, 9);
  });

  it('never lets cached exceed input drive the uncached portion negative', () => {
    // cached > input would make raw (input - cached) negative; clamp to 0.
    const c = computeCost(
      'm',
      { ...ZERO, inputTokens: 100, cachedTokens: 1_000_000 },
      rate,
    ) as Extract<CostEstimate, { available: true }>;
    // uncached clamped to 0; only cached billed (1M × 0.1×10 = 1).
    expect(c.inputUsd).toBeCloseTo(1, 9);
  });
});

describe('sumCost', () => {
  const priced: CostEstimate = { available: true, inputUsd: 1, outputUsd: 2, totalUsd: 3 };
  const priced2: CostEstimate = { available: true, inputUsd: 0, outputUsd: 0, totalUsd: 0.5 };
  const unpriced: CostEstimate = { available: false };

  it('sums when all entries are priced (not partial)', () => {
    expect(sumCost([priced, priced2])).toEqual({ available: true, totalUsd: 3.5, partial: false });
  });

  it('marks a mixed set partial and keeps the priced sum', () => {
    const r = sumCost([priced, unpriced]);
    expect(r.available).toBe(true);
    expect(r.totalUsd).toBeCloseTo(3, 9);
    expect(r.partial).toBe(true);
  });

  it('is unavailable when nothing is priced', () => {
    expect(sumCost([unpriced, unpriced])).toEqual({ available: false, totalUsd: 0, partial: false });
    expect(sumCost([])).toEqual({ available: false, totalUsd: 0, partial: false });
  });
});

describe('parsePricingOverrides', () => {
  it('keeps valid entries and coerces optionals', () => {
    const out = parsePricingOverrides({
      'claude-opus-4-6': {
        inputPerMTok: 15,
        outputPerMTok: 75,
        cachedInputPerMTok: 1.5,
        reasoningPerMTok: 75,
      },
      'gpt-4o': { inputPerMTok: 2.5, outputPerMTok: 10 },
    });
    expect(Object.keys(out).sort()).toEqual(['claude-opus-4-6', 'gpt-4o']);
    expect(out['claude-opus-4-6'].cachedInputPerMTok).toBe(1.5);
    expect(out['gpt-4o'].cachedInputPerMTok).toBeUndefined();
  });

  it('skips entries missing a required rate, with non-finite/negative numbers, or non-object values', () => {
    const out = parsePricingOverrides({
      'missing-output': { inputPerMTok: 1 },
      'nan-input': { inputPerMTok: Number.NaN, outputPerMTok: 1 },
      negative: { inputPerMTok: -1, outputPerMTok: 1 },
      'not-an-object': 5,
      '': { inputPerMTok: 1, outputPerMTok: 1 },
      good: { inputPerMTok: 1, outputPerMTok: 2 },
    });
    expect(Object.keys(out)).toEqual(['good']);
  });

  it('drops malformed optionals but keeps the entry', () => {
    const out = parsePricingOverrides({
      m: { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 'cheap', reasoningPerMTok: -3 },
    });
    expect(out.m).toEqual({ inputPerMTok: 1, outputPerMTok: 2 });
  });

  it('returns {} for non-object / array / null junk', () => {
    expect(parsePricingOverrides(undefined)).toEqual({});
    expect(parsePricingOverrides(null)).toEqual({});
    expect(parsePricingOverrides([{ inputPerMTok: 1, outputPerMTok: 2 }])).toEqual({});
    expect(parsePricingOverrides('nope')).toEqual({});
  });
});
