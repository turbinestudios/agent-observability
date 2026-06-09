/**
 * Pure, `vscode`-free conversion from Copilot's billed usage (AIU) to USD.
 *
 * Mirrors the `escapeHtml.ts` / `workflowParsing.ts` headless-test convention so
 * the arithmetic is unit-tested without the Extension Host.
 *
 * Cost is derived from AIU (premium-request units), the unit GitHub Copilot
 * actually records on each `chat` span (`copilot_chat.copilot_usage_nano_aiu`,
 * already captured as `aiuNano` on the usage rollups). Unlike the previous
 * token×rate estimate, there is no configuration: the conversion is the fixed
 * published rate of 1 AIU = 0.01 USD.
 *
 * Nothing in this module crosses any networked path — cost/usage stay strictly
 * LOCAL-ONLY (see the plan's privacy notes).
 */

/** Fixed conversion: GitHub Copilot bills 1 AIU = 0.01 USD. */
export const USD_PER_AIU = 0.01;

/**
 * Convert integer NANO-AIU (1 AIU = 1e9) to USD at the fixed {@link USD_PER_AIU}
 * rate. Zero/negative input → `0`.
 */
export function aiuToUsd(aiuNano: number): number {
  if (!(aiuNano > 0)) {
    return 0;
  }
  return (aiuNano / 1_000_000_000) * USD_PER_AIU;
}
