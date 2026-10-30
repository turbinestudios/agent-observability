import { describe, expect, it } from 'vitest';
import { copilotCreditsNano } from './copilotCredits';

describe('copilotCreditsNano', () => {
  it('bills each token bucket at the model rate, 1 credit = $0.01', () => {
    // Claude Opus 5.5: $4 input, $0.20 cached, $5 cache write, $20 output per 1M.
    // 1,000,000 × 4 + 1,000,000 × 0.2 + 100,000 × 5 + 10,000 × 20 = $4.90 = 490 credits.
    expect(copilotCreditsNano('claude-opus-5.5', { input: 1_000_000, cacheRead: 1_000_000, cacheWrite: 100_000, output: 10_000 })).toBe(
      490_000_000_000,
    );
  });

  it('reproduces a call the Copilot CLI billed', () => {
    // Claude Sonnet 5 from a real assistant_usage_events row, in fresh/read/write/output buckets.
    const nano = copilotCreditsNano('claude-sonnet-5', { input: 4, cacheRead: 0, cacheWrite: 29_882, output: 35 });
    expect(nano).toBe(Math.round((4 * 2 + 29_882 * 2.5 + 35 * 10) * 100_000));
  });

  it('matches model ids case-insensitively', () => {
    const tokens = { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 0 };
    expect(copilotCreditsNano('Claude-Opus-5.5', tokens)).toBe(copilotCreditsNano('claude-opus-5.5', tokens));
  });

  it('switches to the long-context tier once the prompt passes the threshold', () => {
    // Claude Haiku 5.5: $0.10 input up to 100K prompt tokens, $0.50 above.
    expect(copilotCreditsNano('claude-haiku-5.5', { input: 100_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBe(1_000_000_000);
    expect(copilotCreditsNano('claude-haiku-5.5', { input: 60_000, cacheRead: 40_001, cacheWrite: 0, output: 0 })).toBe(
      Math.round((60_000 * 0.5 + 40_001 * 0.05) * 100_000),
    );
  });

  it('bills cache writes as input where the model lists no cache-write price', () => {
    expect(copilotCreditsNano('gpt-5.4-nano', { input: 0, cacheRead: 0, cacheWrite: 1_000_000, output: 0 })).toBe(20_000_000_000);
  });

  it('leaves a model without a published rate unpriced', () => {
    expect(copilotCreditsNano('gpt-5-mini', { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeUndefined();
    expect(copilotCreditsNano(undefined, { input: 1_000, cacheRead: 0, cacheWrite: 0, output: 0 })).toBeUndefined();
  });
});
