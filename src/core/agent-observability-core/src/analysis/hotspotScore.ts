/**
 * The composite hotspot score — a transparent formula, computed locally. Lives in core so the desktop Dashboard, the repository
 * hub and the Team view all rank with the same numbers.
 *
 * Each sub-score is normalized to [0,1]:
 * - skip      = skipped / (applied + skipped)                (0 when never offered)
 * - friction  = min(1, (errorSessions + deviationSessions) / max(1, applied))
 *               — co-occurrence only, never a causal claim
 * - token     = min(1, estTokensMax / TOKEN_BUDGET)
 * - frequency = applied / max(applied across the result set)
 *
 * score = 100 × (0.30·skip + 0.30·friction + 0.20·token + 0.20·frequency).
 * Weights favor actionable problems (misconfiguration + friction) while still
 * surfacing high-impact, frequently-applied files worth refining.
 */

/** Token count at which the token-weight sub-score saturates to 1. */
export const HOTSPOT_TOKEN_BUDGET = 2_000;

const SKIP_WEIGHT = 0.3;
const FRICTION_WEIGHT = 0.3;
const TOKEN_WEIGHT = 0.2;
const FREQUENCY_WEIGHT = 0.2;

/** The fields the formula reads; `file` is the deterministic tie-break identity. */
export interface Scorable {
  file: string;
  appliedCount: number;
  skippedCount: number;
  estTokensMax: number;
  errorSessions: number;
  deviationSessions: number;
}

/**
 * Score every row and rank highest-first. The whole set must be passed — the
 * frequency sub-score normalizes by the set's busiest file — and the caller
 * truncates afterwards. Ties break like the cloud page: total trouble signals
 * (skips + error + deviation sessions) descending, then path ascending, so the
 * order cannot flap between runs.
 */
export function scoreHotspots<T extends Scorable>(rows: readonly T[]): (T & { score: number })[] {
  const maxApplied = rows.reduce((max, row) => Math.max(max, row.appliedCount), 0);

  const scored = rows.map((row): T & { score: number } => {
    const offered = row.appliedCount + row.skippedCount;
    const skip = offered > 0 ? row.skippedCount / offered : 0;
    const friction = clamp01(
      (row.errorSessions + row.deviationSessions) / Math.max(1, row.appliedCount),
    );
    const token = clamp01(row.estTokensMax / HOTSPOT_TOKEN_BUDGET);
    const frequency = maxApplied > 0 ? clamp01(row.appliedCount / maxApplied) : 0;
    const score =
      100 *
      (SKIP_WEIGHT * skip + FRICTION_WEIGHT * friction + TOKEN_WEIGHT * token + FREQUENCY_WEIGHT * frequency);
    return { ...row, score };
  });

  scored.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    const troubleA = a.skippedCount + a.errorSessions + a.deviationSessions;
    const troubleB = b.skippedCount + b.errorSessions + b.deviationSessions;
    if (troubleA !== troubleB) {
      return troubleB - troubleA;
    }
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
  });
  return scored;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
