/**
 * Pure, `vscode`-free cost-estimation for per-session, per-model token usage.
 *
 * Mirrors the `escapeHtml.ts` / `workflowParsing.ts` headless-test convention so
 * the arithmetic and the lenient settings parser are unit-tested without the
 * Extension Host.
 *
 * IMPORTANT — cost is always an ESTIMATE. GitHub Copilot does not record or bill
 * per token, so there is NO authoritative cost in the local telemetry DB. Cost
 * here is purely `tokens × a user-configured per-model rate`. There is NO
 * built-in rate table: every model reads `n/a` until the user configures
 * `agentObservability.pricing.modelRates`. An unknown/unpriced model is `n/a`
 * (never `$0`); a KNOWN rate applied to zero tokens is a legitimate `$0`.
 *
 * Nothing in this module crosses any networked path — cost/tokens stay
 * strictly LOCAL-ONLY (see the plan's privacy notes).
 */

/** Per-model rate, expressed in USD per 1,000,000 tokens. */
export interface ModelRate {
  /** USD per 1M uncached input tokens. */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
  /** USD per 1M cached input tokens. Omit → `0.1 × inputPerMTok` (discounted). */
  cachedInputPerMTok?: number;
  /** USD per 1M reasoning tokens. Omit → `outputPerMTok`. */
  reasoningPerMTok?: number;
}

/** Token counts for a single model within a session (0 when a column is absent). */
export interface ModelTokens {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
}

/**
 * The estimated USD cost for one model's token usage, or `{ available: false }`
 * when no rate is configured for the model (rendered as `n/a`, never `$0`).
 */
export type CostEstimate =
  | { available: true; inputUsd: number; outputUsd: number; totalUsd: number }
  | { available: false };

/**
 * Normalize a model id so a single settings key can match the real divergences
 * in the local data:
 * - case/whitespace: `  Claude-Opus-4-6 ` → `claude-opus-4-6`;
 * - request/response divergence: the request side records dotted versions
 *   (`claude-opus-4.6`) while the response side records dashed (`claude-opus-4-6`)
 *   — dots collapse to dashes so both forms map to one key;
 * - dated suffixes: `gpt-4o-mini-2024-07-18` → `gpt-4o-mini`.
 *
 * Pass-through for ids with no special shape (`unknown`, `''`). Used to
 * normalize BOTH the data id and the settings keys (see {@link rateForModel}),
 * so matching is symmetric regardless of which form the user typed.
 */
export function normalizeModelId(model: string): string {
  let id = model.trim().toLowerCase();
  // Strip a trailing ISO-ish date suffix (-YYYY-MM-DD) before touching dots —
  // dates in model ids are always dash-separated.
  id = id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  // Version separators differ between request (dotted) and response (dashed).
  id = id.replace(/\./g, '-');
  return id;
}

/**
 * Find the configured {@link ModelRate} for `model`, matching by normalized id so
 * the dotted request form and dashed response form (and dated suffixes) all
 * resolve to a single user-provided key. Returns `undefined` when no key matches.
 */
export function rateForModel(
  model: string,
  rates: Readonly<Record<string, ModelRate>>,
): ModelRate | undefined {
  const target = normalizeModelId(model);
  for (const [key, rate] of Object.entries(rates)) {
    if (normalizeModelId(key) === target) {
      return rate;
    }
  }
  return undefined;
}

/**
 * Estimate the USD cost of `tokens` for `model` under `rates`.
 *
 * Returns `{ available: false }` when no rate is configured (→ `n/a`). When a
 * rate is found:
 * - `uncachedInput = max(0, inputTokens − cachedTokens)` (cached is a subset of
 *   input in the Copilot data), billed at `inputPerMTok`;
 * - cached input billed at `cachedInputPerMTok ?? 0.1 × inputPerMTok`;
 * - output billed at `outputPerMTok`;
 * - reasoning billed at `reasoningPerMTok ?? outputPerMTok`.
 */
export function computeCost(
  model: string,
  tokens: ModelTokens,
  rates: Readonly<Record<string, ModelRate>>,
): CostEstimate {
  const rate = rateForModel(model, rates);
  if (rate === undefined) {
    return { available: false };
  }
  const uncachedInput = Math.max(0, tokens.inputTokens - tokens.cachedTokens);
  const cachedRate = rate.cachedInputPerMTok ?? 0.1 * rate.inputPerMTok;
  const reasoningRate = rate.reasoningPerMTok ?? rate.outputPerMTok;
  const inputUsd =
    (uncachedInput / 1_000_000) * rate.inputPerMTok +
    (tokens.cachedTokens / 1_000_000) * cachedRate;
  const outputUsd =
    (tokens.outputTokens / 1_000_000) * rate.outputPerMTok +
    (tokens.reasoningTokens / 1_000_000) * reasoningRate;
  return { available: true, inputUsd, outputUsd, totalUsd: inputUsd + outputUsd };
}

/**
 * Sum a set of per-model estimates into one session total.
 *
 * - `available` is true when ANY model was priced (so a partially-priced session
 *   still shows a number rather than blanking out);
 * - `partial` is true when SOME models were priced and SOME were not — the
 *   renderer appends an `n/a` marker to the partial sum.
 */
export function sumCost(estimates: readonly CostEstimate[]): {
  available: boolean;
  totalUsd: number;
  partial: boolean;
} {
  let totalUsd = 0;
  let anyPriced = false;
  let anyUnpriced = false;
  for (const e of estimates) {
    if (e.available) {
      totalUsd += e.totalUsd;
      anyPriced = true;
    } else {
      anyUnpriced = true;
    }
  }
  return { available: anyPriced, totalUsd, partial: anyPriced && anyUnpriced };
}

/** Raw shape of one entry in `agentObservability.pricing.modelRates`. */
interface RawModelRate {
  inputPerMTok?: unknown;
  outputPerMTok?: unknown;
  cachedInputPerMTok?: unknown;
  reasoningPerMTok?: unknown;
}

/** A finite, non-negative number, else `undefined`. */
function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * Pure, lenient parser for `agentObservability.pricing.modelRates` (mirrors
 * {@link ../config/workflowParsing.parseWorkflowConfigs}): a `Record<modelId,
 * ModelRate>`. An entry is kept only when both `inputPerMTok` and `outputPerMTok`
 * are finite, non-negative numbers; the optional `cachedInputPerMTok` /
 * `reasoningPerMTok` are coerced the same way and dropped when malformed.
 * Anything else (non-object input, blank keys, missing required rates) is
 * silently skipped so a hand-edited settings.json can never break the panel.
 */
export function parsePricingOverrides(raw: unknown): Record<string, ModelRate> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {};
  }
  const out: Record<string, ModelRate> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key.trim().length === 0 || typeof value !== 'object' || value === null) {
      continue;
    }
    const v = value as RawModelRate;
    const inputPerMTok = finiteNonNegative(v.inputPerMTok);
    const outputPerMTok = finiteNonNegative(v.outputPerMTok);
    if (inputPerMTok === undefined || outputPerMTok === undefined) {
      continue;
    }
    const rate: ModelRate = { inputPerMTok, outputPerMTok };
    const cachedInputPerMTok = finiteNonNegative(v.cachedInputPerMTok);
    if (cachedInputPerMTok !== undefined) {
      rate.cachedInputPerMTok = cachedInputPerMTok;
    }
    const reasoningPerMTok = finiteNonNegative(v.reasoningPerMTok);
    if (reasoningPerMTok !== undefined) {
      rate.reasoningPerMTok = reasoningPerMTok;
    }
    out[key] = rate;
  }
  return out;
}
