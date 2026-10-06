import type { CompletionStatus, SessionRow } from '../../../../shared/rpc';

/**
 * How the completion check reads on a session row. Wording rule for the whole
 * feature: say what was and was not OBSERVED in the session's own log, never
 * what the agent intended. A check run in CI, another terminal or a hook is
 * invisible here, and every tooltip says so.
 */

export function completionLabel(status: CompletionStatus): string {
  switch (status) {
    case 'verified':
      return 'Verified';
    case 'unverified':
      return 'Not verified';
    case 'contradicted':
      return 'Check failed';
    case 'incomplete':
      return 'Left unfinished';
  }
}

/** Visual weight: only a failed last check is alarming; the rest are notes. */
export function completionTone(status: CompletionStatus): 'good' | 'note' | 'warn' | 'muted' {
  switch (status) {
    case 'verified':
      return 'good';
    case 'unverified':
      return 'note';
    case 'contradicted':
      return 'warn';
    case 'incomplete':
      return 'muted';
  }
}

const LIMITS = 'Based only on what this session recorded; checks run elsewhere are not visible.';

export function completionTooltip(status: CompletionStatus, claimedDone: boolean): string {
  const claim = claimedDone ? ' The last reply reported the work as done.' : '';
  switch (status) {
    case 'verified':
      return `A test, build, lint or type-check was seen passing after the last code edit.${claim} ${LIMITS}`;
    case 'unverified':
      return `No test, build, lint or type-check with an observed result was seen after the last code edit.${claim} ${LIMITS}`;
    case 'contradicted':
      return `The last check seen after the final code edit failed, and nothing ran after it.${claim} ${LIMITS}`;
    case 'incomplete':
      return `The session ended without finishing: work was said to remain, or it stopped on a failed step. ${LIMITS}`;
  }
}

/**
 * Which rows carry the chip. Verified rows stay quiet, like smooth verdicts:
 * the list marks what deserves a look, and the detail card states the rest.
 */
export function showsCompletionChip(row: Pick<SessionRow, 'completion' | 'claimedDone'>): boolean {
  if (row.completion === undefined || row.completion === 'verified') {
    return false;
  }
  return row.completion !== 'unverified' || row.claimedDone === true;
}
