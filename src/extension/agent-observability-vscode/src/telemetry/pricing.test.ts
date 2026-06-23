import { describe, it, expect } from 'vitest';
import { USD_PER_AIU, aiuToUsd } from './pricing';

describe('USD_PER_AIU', () => {
  it('is the fixed published rate of 0.01 USD per AIU', () => {
    expect(USD_PER_AIU).toBe(0.01);
  });
});

describe('aiuToUsd', () => {
  it('converts integer NANO-AIU (1 AIU = 1e9) to USD at the fixed rate', () => {
    // 1 AIU → $0.01
    expect(aiuToUsd(1_000_000_000)).toBeCloseTo(0.01, 10);
    // 100 AIU → $1.00
    expect(aiuToUsd(100_000_000_000)).toBeCloseTo(1, 10);
    // 536.264925 AIU → $5.36264925
    expect(aiuToUsd(536_264_925_000)).toBeCloseTo(5.36264925, 8);
  });

  it('treats zero, negative, and absent usage as $0 (never billed)', () => {
    expect(aiuToUsd(0)).toBe(0);
    expect(aiuToUsd(-5_000_000_000)).toBe(0);
    expect(aiuToUsd(Number.NaN)).toBe(0);
  });

  it('handles sub-AIU usage', () => {
    // 0.5 AIU → $0.005
    expect(aiuToUsd(500_000_000)).toBeCloseTo(0.005, 10);
  });
});
