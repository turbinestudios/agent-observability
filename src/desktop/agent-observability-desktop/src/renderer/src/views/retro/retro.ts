import type { AnalysisStatus, RetroListRow, RetroVerdict } from '../../../../shared/rpc';

/**
 * Presentation rules for the Retro view, kept out of the component so they can
 * be tested without a DOM.
 */

/** The verdict tiers a chip can narrow the table to, worst first. */
export const VERDICT_FILTERS: readonly RetroVerdict[] = ['abandoned', 'struggled', 'bumpy', 'smooth'];

/** CSS modifier for a verdict chip in this view. */
export function verdictChipClass(verdict: RetroVerdict): string {
  return `retro-view-chip-${verdict}`;
}

/**
 * One row's friction, compressed to the numbers that are actually non-zero —
 * a row of dashes would bury the one signal that matters in noise.
 */
export function frictionSummary(row: RetroListRow): string {
  const parts: string[] = [];
  if (row.correctionTurns > 0) {
    parts.push(row.correctionTurns === 1 ? '1 correction' : `${row.correctionTurns} corrections`);
  }
  if (row.repeatedPromptTurns > 0) {
    parts.push(row.repeatedPromptTurns === 1 ? '1 re-ask' : `${row.repeatedPromptTurns} re-asks`);
  }
  if (row.interruptions > 0) {
    parts.push(row.interruptions === 1 ? '1 interruption' : `${row.interruptions} interruptions`);
  }
  if (row.maxErrorStreak > 0) {
    parts.push(`worst error streak ${row.maxErrorStreak}`);
  }
  if (row.churnRatioPct > 0) {
    parts.push(`${row.churnRatioPct}% rework`);
  }
  if (row.compactions > 0) {
    parts.push(row.compactions === 1 ? '1 compaction' : `${row.compactions} compactions`);
  }
  return parts.join(' · ');
}

/** Coverage line under the heading: what the ranking is built from. */
export function describeRetroCoverage(rows: readonly RetroListRow[], status: AnalysisStatus): string {
  if (rows.length === 0) {
    return 'No judged sessions yet.';
  }
  const judged = rows.length === 1 ? '1 judged session' : `${rows.length.toLocaleString()} judged sessions`;
  const analyzed =
    status.analyzed === 1 ? '1 session analyzed' : `${status.analyzed.toLocaleString()} sessions analyzed`;
  return `${judged}, of the ${analyzed} so far.`;
}
