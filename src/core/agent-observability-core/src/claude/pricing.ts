import { TranscriptUsage } from './transcript';

/**
 * Pure, `vscode`-free USD cost estimation for Claude Code token usage.
 *
 * Unlike the Copilot path (which bills in AIU — see `../telemetry/pricing.ts`),
 * Claude usage is priced by tokens at the published per-model rates. Cost is
 * accumulated in INTEGER micro-USD (1 USD = 1e6 micros) so summing thousands of
 * turns stays exact; divide by 1e6 at the display boundary.
 *
 * Rates (USD per 1M tokens) and the cache multipliers are the published Anthropic
 * figures (confirmed via the `claude-api` skill, June 2026): cache READS bill at
 * ~0.1× the input rate and cache WRITES at ~1.25× the input rate (the default
 * 5-minute ephemeral TTL Claude Code uses). Output is the output rate.
 *
 * Nothing here crosses a networked path — cost/usage stay strictly LOCAL-ONLY.
 */

/** Per-1M-token USD rates for a model family. */
interface ModelRate {
  /** Input (uncached) USD per 1M tokens. */
  input: number;
  /** Output USD per 1M tokens. */
  output: number;
}

/** Cache-read bills at this fraction of the input rate. */
const CACHE_READ_MULTIPLIER = 0.1;
/** Cache-write (5-minute ephemeral) bills at this multiple of the input rate. */
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Micro-USD per USD. */
const MICROS_PER_USD = 1_000_000;

/**
 * Rate table keyed by a normalized family key (see {@link modelKey}). Kept small
 * and explicit; an unknown model resolves to {@link UNKNOWN_RATE} (cost 0) rather
 * than guessing, and the mapper can surface that the cost is unpriced.
 */
const RATES: ReadonlyMap<string, ModelRate> = new Map<string, ModelRate>([
  ['fable-5', { input: 10, output: 50 }],
  ['mythos-5', { input: 10, output: 50 }],
  // Opus 4.5–4.8 share $5 / $25; legacy 4.0/4.1 and Opus 3 are $15 / $75.
  ['opus-4-8', { input: 5, output: 25 }],
  ['opus-4-7', { input: 5, output: 25 }],
  ['opus-4-6', { input: 5, output: 25 }],
  ['opus-4-5', { input: 5, output: 25 }],
  ['opus-4-1', { input: 15, output: 75 }],
  ['opus-4-0', { input: 15, output: 75 }],
  ['opus-3', { input: 15, output: 75 }],
  ['sonnet-4-6', { input: 3, output: 15 }],
  ['sonnet-4-5', { input: 3, output: 15 }],
  ['sonnet-4-0', { input: 3, output: 15 }],
  ['sonnet-3-7', { input: 3, output: 15 }],
  ['sonnet-3-5', { input: 3, output: 15 }],
  ['haiku-4-5', { input: 1, output: 5 }],
  ['haiku-3-5', { input: 0.8, output: 4 }],
  ['haiku-3', { input: 0.25, output: 1.25 }],
]);

/** Whether a model id maps to a known rate (so callers can flag unpriced cost). */
export function isKnownModel(model: string | undefined | null): boolean {
  return resolveRate(model) !== undefined;
}

/**
 * Estimate the cost of one message's usage, in INTEGER micro-USD.
 *
 * Splits cached input from uncached: `input_tokens` are uncached and bill at the
 * full input rate; `cache_read_input_tokens` at 0.1×; `cache_creation_input_tokens`
 * at 1.25×; `output_tokens` at the output rate. An unknown model yields 0.
 */
export function claudeCostMicros(
  model: string | undefined | null,
  usage: TranscriptUsage | undefined,
): number {
  const rate = resolveRate(model);
  if (rate === undefined || usage === undefined) {
    return 0;
  }
  const input = safe(usage.input_tokens);
  const output = safe(usage.output_tokens);
  const cacheRead = safe(usage.cache_read_input_tokens);
  const cacheWrite = safe(usage.cache_creation_input_tokens);

  // USD = tokens / 1e6 * ratePerMTok  ⇒  micro-USD = tokens * ratePerMTok.
  const usd =
    (input * rate.input +
      output * rate.output +
      cacheRead * rate.input * CACHE_READ_MULTIPLIER +
      cacheWrite * rate.input * CACHE_WRITE_MULTIPLIER) /
    1_000_000;

  return Math.round(usd * MICROS_PER_USD);
}

/** Convert integer micro-USD to USD. */
export function microsToUsd(micros: number): number {
  if (!Number.isFinite(micros)) {
    return 0;
  }
  return micros / MICROS_PER_USD;
}

/**
 * Normalize a raw model id to a rate-table key: lowercase, strip a trailing
 * `-YYYYMMDD` snapshot date, then collapse a `claude-` prefix. E.g.
 * `claude-haiku-4-5-20251001` → `haiku-4-5`, `claude-opus-4-7` → `opus-4-7`.
 */
export function modelKey(model: string): string {
  let key = model.trim().toLowerCase();
  key = key.replace(/-\d{8}$/, '');
  key = key.replace(/^claude-/, '');
  return key;
}

/** Look up the rate for a model id, or `undefined` when unknown. */
function resolveRate(model: string | undefined | null): ModelRate | undefined {
  if (model === undefined || model === null || model.length === 0) {
    return undefined;
  }
  const key = modelKey(model);
  const exact = RATES.get(key);
  if (exact !== undefined) {
    return exact;
  }
  // Tolerate minor/patch variants we don't enumerate (e.g. a future `opus-4-9`)
  // by matching on a known `<family>-<major>` prefix, then by bare family.
  for (const [rateKey, rate] of RATES) {
    if (key.startsWith(`${rateKey}-`)) {
      return rate;
    }
  }
  return matchFamily(key);
}

/** Last-resort family match (`opus-*`/`sonnet-*`/`haiku-*`/`fable-*`). */
function matchFamily(key: string): ModelRate | undefined {
  if (key.startsWith('fable') || key.startsWith('mythos')) {
    return { input: 10, output: 50 };
  }
  if (key.startsWith('opus')) {
    return { input: 5, output: 25 };
  }
  if (key.startsWith('sonnet')) {
    return { input: 3, output: 15 };
  }
  if (key.startsWith('haiku')) {
    return { input: 1, output: 5 };
  }
  return undefined;
}

function safe(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return 0;
  }
  return value;
}
