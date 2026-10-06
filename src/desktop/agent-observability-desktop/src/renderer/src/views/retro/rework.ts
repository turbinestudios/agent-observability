import type { SessionFilters } from '../sessions/filters';
import { REWORK_LINES_MIN, REWORK_REEDIT_MIN_TURNS } from '../../../../shared/rpc';

/**
 * Presentation rules for the rework signal, split from the components so they
 * test under the node-only vitest setup like `completionCounts.ts`.
 *
 * Wording rule: rework is a proxy. Nothing here says a session was bad; it
 * says what was observed (a file edited in several turns, lines added and
 * later removed) and leaves the judgement to the reader.
 */

/** What the Rework chip and the tab say the signal means, thresholds included. */
export const REWORK_EXPLANATION =
  `A file was edited in ${REWORK_REEDIT_MIN_TURNS} or more separate turns, or at least ${REWORK_LINES_MIN} lines ` +
  'the session added were removed again in a later turn. A signal of rework, not a quality score.';

/** Whether a session row carries the Rework chip. Mirrors the SQL filter. */
export function showsReworkChip(row: { filesReedited?: number; reworkedLines?: number }): boolean {
  return (row.filesReedited ?? 0) > 0 || (row.reworkedLines ?? 0) >= REWORK_LINES_MIN;
}

/** The chip's tooltip: this session's own numbers, then what the signal means. */
export function reworkTooltip(row: { filesReedited?: number; reworkedLines?: number }): string {
  const parts: string[] = [];
  const files = row.filesReedited ?? 0;
  const lines = row.reworkedLines ?? 0;
  if (files > 0) {
    parts.push(files === 1 ? '1 file edited repeatedly' : `${files} files edited repeatedly`);
  }
  if (lines > 0) {
    parts.push(lines === 1 ? '1 added line removed again' : `${lines} added lines removed again`);
  }
  return `${parts.join(', ')}. ${REWORK_EXPLANATION}`;
}

/** `3 of 12 sessions that edited files (25%)`, hand-formatted so every machine prints the same. */
export function reworkRateLine(reworked: number, edited: number): string {
  if (edited === 0) {
    return 'No analysed session in this window edited files';
  }
  const pct = Math.round((reworked / edited) * 100);
  return `${reworked} of ${edited} ${edited === 1 ? 'session' : 'sessions'} that edited files (${pct}%)`;
}

/** One line of detail for a ranked session. */
export function reworkSessionLine(row: { filesReedited: number; reworkedLines: number }): string {
  const parts: string[] = [];
  if (row.filesReedited > 0) {
    parts.push(row.filesReedited === 1 ? '1 file re-edited' : `${row.filesReedited} files re-edited`);
  }
  if (row.reworkedLines > 0) {
    parts.push(row.reworkedLines === 1 ? '1 line reworked' : `${row.reworkedLines} lines reworked`);
  }
  return parts.join(', ');
}

/** The Sessions drill-down for "every session the signal fired for". */
export function reworkedFilter(base: SessionFilters): SessionFilters {
  return { ...base, reworked: true };
}
