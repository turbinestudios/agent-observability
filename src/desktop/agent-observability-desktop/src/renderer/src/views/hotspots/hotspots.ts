import { OVERSIZED_THRESHOLD_TOKENS } from '@agent-observability/core/src/context/models';
import type { AnalysisStatus, HotspotRow } from '../../../../shared/rpc';

/**
 * Presentation rules for the Context Hotspots table, kept out of the component
 * so they can be tested without a DOM.
 */

export { OVERSIZED_THRESHOLD_TOKENS };

/** Human label for a context file's category. */
export function categoryLabel(category: string): string {
  switch (category) {
    case 'instruction':
      return 'Instruction';
    case 'skill':
      return 'Skill';
    case 'agent':
      return 'Agent';
    case 'hook':
      return 'Hook';
    case 'prompt':
      return 'Prompt';
    default:
      return 'Other';
  }
}

/**
 * Whether a file is over the guideline every context file is judged against —
 * the same threshold the session detail flags, so the two never disagree.
 */
export function isOversized(estTokens: number): boolean {
  return estTokens > OVERSIZED_THRESHOLD_TOKENS;
}

/**
 * The tail of a path, for a column that cannot show the whole thing.
 *
 * Files are identified by absolute path, and the interesting part is always the
 * end: `.claude/skills/deploy.md` says what a file is, where the leading
 * directories say only where the checkout lives. The full path stays available
 * as the cell's title.
 */
export function shortPath(file: string, segments = 3): string {
  const parts = file.split(/[\\/]/).filter((p) => p.length > 0);
  if (parts.length <= segments) {
    return parts.join('/');
  }
  return `…/${parts.slice(-segments).join('/')}`;
}

/**
 * What to say about a ranking that is still filling in, or `undefined` when it
 * is complete. A partial ranking is worth showing — it is already ordered — but
 * only if the view says outright that it is partial.
 */
export function describeProgress(status: AnalysisStatus): string | undefined {
  if (!status.running && status.analyzed >= status.total) {
    return undefined;
  }
  const remaining = Math.max(0, status.total - status.analyzed);
  if (remaining === 0) {
    return 'Finishing up…';
  }
  return `Reading sessions — ${remaining.toLocaleString()} to go. The ranking fills in as they land.`;
}

/** Summary line under the heading: what the ranking is built from. */
export function describeCoverage(rows: readonly HotspotRow[], status: AnalysisStatus): string {
  if (rows.length === 0) {
    return 'No context files found yet.';
  }
  const files = rows.length === 1 ? '1 file' : `${rows.length.toLocaleString()} files`;
  const sessions =
    status.analyzed === 1 ? '1 session' : `${status.analyzed.toLocaleString()} sessions`;
  return `${files} across the ${sessions} analyzed so far.`;
}
