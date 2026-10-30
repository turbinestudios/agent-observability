import { USD_PER_AIU } from './pricing';

/**
 * GitHub Copilot AI credits for one model call, computed from its tokens.
 *
 * Copilot bills AI credits (1 credit = 1 AIU = 0.01 USD) per token at fixed
 * per-model rates. The rates below are copied from GitHub's published table
 * (https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing,
 * 2026-10-30). Checked against the Copilot CLI's own `session-store.db`: these
 * rates reproduce every call's billed `total_nano_aiu` exactly, whatever its
 * request multiplier.
 *
 * Used for clients that call Copilot without recording what it billed
 * (OpenCode records a list-price estimate instead). A model missing from the
 * table has no credits, so its calls stay unpriced rather than guessed.
 */

/** USD per 1M tokens. A tier applies while the prompt is at most `maxPromptTokens`. */
interface CreditTier {
  maxPromptTokens?: number;
  input: number;
  cachedInput: number;
  /** Absent where GitHub lists no cache-write price: cache writes bill as input. */
  cacheWrite?: number;
  output: number;
}

const flat = (input: number, cachedInput: number, output: number, cacheWrite?: number): CreditTier[] => [
  { input, cachedInput, output, ...(cacheWrite !== undefined ? { cacheWrite } : {}) },
];

const tiered = (threshold: number, base: Omit<CreditTier, 'maxPromptTokens'>, long: Omit<CreditTier, 'maxPromptTokens'>): CreditTier[] => [
  { maxPromptTokens: threshold, ...base },
  long,
];

/** Keyed by the lowercase model id the Copilot API takes (`claude-opus-5.5`). */
export const COPILOT_CREDIT_RATES: ReadonlyMap<string, readonly CreditTier[]> = new Map([
  // OpenAI
  ['gpt-5.3-codex', flat(1.75, 0.175, 14)],
  ['gpt-5.4-nano', flat(0.2, 0.02, 1.25)],
  ['gpt-5.6-luna', tiered(200_000, { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 1.2 }, { input: 0.4, cachedInput: 0.04, cacheWrite: 0.5, output: 1.8 })],
  ['gpt-5.6-sol', tiered(272_000, { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 20 }, { input: 8, cachedInput: 0.8, cacheWrite: 10, output: 30 })],
  ['gpt-5.6-terra', tiered(272_000, { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 12 }, { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 18 })],
  ['gpt-6-astra', tiered(272_000, { input: 10, cachedInput: 1, cacheWrite: 12.5, output: 50 }, { input: 20, cachedInput: 2, cacheWrite: 25, output: 75 })],
  ['gpt-6-luna', tiered(272_000, { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, { input: 0.2, cachedInput: 0.02, cacheWrite: 0.25, output: 0.75 })],
  ['gpt-6-sol', tiered(272_000, { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 }, { input: 4, cachedInput: 0.4, cacheWrite: 5, output: 15 })],
  ['gpt-6.1-sol', tiered(272_000, { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 10 }, { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 15 })],
  ['gpt-6.1-terra', tiered(272_000, { input: 1, cachedInput: 0.05, cacheWrite: 1.25, output: 5 }, { input: 2, cachedInput: 0.1, cacheWrite: 2.5, output: 7.5 })],
  // Anthropic
  ['claude-haiku-4.5', flat(1, 0.1, 5, 1.25)],
  ['claude-haiku-5.5', tiered(100_000, { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 }, { input: 0.5, cachedInput: 0.05, cacheWrite: 0.625, output: 2.5 })],
  ['claude-sonnet-4', flat(3, 0.3, 15, 3.75)],
  ['claude-sonnet-4.6', flat(3, 0.3, 15, 3.75)],
  ['claude-opus-4.8', flat(5, 0.5, 25, 6.25)],
  ['claude-opus-5', flat(5, 0.5, 25, 6.25)],
  ['claude-opus-5.5', flat(4, 0.2, 20, 5)],
  ['claude-sonnet-5', flat(2, 0.2, 10, 2.5)],
  ['claude-sonnet-5.5', flat(2, 0.1, 10, 2.5)],
  ['claude-fable-5', flat(10, 1, 50, 12.5)],
  ['claude-fable-5.1', flat(10, 0.25, 50, 12.5)],
  // Google
  ['gemini-3.8-flash', flat(0.75, 0.075, 3.75)],
  ['gemini-4-argon', flat(2, 0.1, 10)],
  // Microsoft
  ['mai-code-1.1-flash', flat(0.2, 0.02, 1.2)],
  // xAI
  ...['grok-4.5', 'grok-4.6', 'grok-4.7'].map(
    (id) => [id, tiered(200_000, { input: 2, cachedInput: 0.5, output: 6 }, { input: 4, cachedInput: 1, output: 12 })] as const,
  ),
  // Moonshot AI
  ['kimi-k3', flat(3, 0.3, 15)],
]);

/** Disjoint token buckets of one call: fresh input, cache reads, cache writes, output. */
export interface CopilotCallTokens {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * The call's AI credits in integer NANO-AIU (1 credit = 1e9), or `undefined`
 * when the model has no published rate. Pass reasoning tokens in `output`
 * when the client counts them separately.
 */
export function copilotCreditsNano(modelId: string | undefined, tokens: CopilotCallTokens): number | undefined {
  const tiers = modelId !== undefined ? COPILOT_CREDIT_RATES.get(modelId.trim().toLowerCase()) : undefined;
  if (tiers === undefined) {
    return undefined;
  }
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite;
  const tier = tiers.find((t) => t.maxPromptTokens === undefined || prompt <= t.maxPromptTokens) ?? tiers.at(-1);
  if (tier === undefined) {
    return undefined;
  }
  const usdTimesMillion =
    tokens.input * tier.input +
    tokens.cacheRead * tier.cachedInput +
    tokens.cacheWrite * (tier.cacheWrite ?? tier.input) +
    tokens.output * tier.output;
  // USD = usdTimesMillion / 1e6; credits = USD / USD_PER_AIU; nano = credits × 1e9.
  return Math.round((usdTimesMillion / USD_PER_AIU) * 1_000);
}
