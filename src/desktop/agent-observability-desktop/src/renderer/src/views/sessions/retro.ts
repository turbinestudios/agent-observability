import type { RetroVerdict } from '../../../../shared/rpc';

/**
 * Presentation rules for retrospective verdicts in the renderer, split out of
 * the components so they are testable without a DOM (house rule).
 */

/** Plain-language name for a verdict, matching the detail card's labels. */
export function verdictLabel(verdict: RetroVerdict): string {
  switch (verdict) {
    case 'smooth':
      return 'Went smoothly';
    case 'bumpy':
      return 'Some friction';
    case 'struggled':
      return 'Struggled';
    case 'abandoned':
      return 'Left unfinished';
  }
}

/**
 * Whether a session row shows a verdict chip. Only the two worst tiers do:
 * most sessions go fine, and marking every row would turn the list into
 * confetti — the detail card still states smooth and bumpy verdicts.
 */
export function showsVerdictChip(verdict: RetroVerdict | undefined): verdict is RetroVerdict {
  return verdict === 'struggled' || verdict === 'abandoned';
}

/**
 * Plain-language name for a retrospective finding signal — the Dashboard's
 * theme card and the matching session-list chip both read from here.
 *
 * Core exports no per-id label (its descriptions are per-occurrence sentences),
 * so the map lives in the renderer like `verdictLabel` and `categoryLabel` do.
 * An id this map does not know falls back to itself: a future core signal
 * appears unlabelled rather than being hidden.
 */
export function themeLabel(signalId: string): string {
  switch (signalId) {
    case 'correction-reprompt':
      return 'Correction re-prompts';
    case 'repeated-prompt':
      return 'Repeated prompts';
    case 'user-interruption':
      return 'Mid-run interruptions';
    case 'tool-error-streak':
      return 'Tool-error streaks';
    case 'rework-churn':
      return 'Rework churn';
    case 'context-compaction':
      return 'Context compactions';
    case 'vague-first-prompt':
      return 'Vague opening prompts';
    case 'oversized-first-prompt':
      return 'Oversized opening prompts';
    case 'abandoned-ending':
      return 'Sessions left unfinished';
    case 'completion-unverified':
      return 'Reported done, no check seen';
    case 'completion-contradicted':
      return 'Reported done, last check failed';
    case 'incomplete-ending':
      return 'Ended with work remaining';
    case 'file-rework':
      return 'Files edited repeatedly';
    case 'long-tail-turn':
      return 'Long-running turns';
    case 'subagent-heavy':
      return 'Sub-agent heavy runs';
    case 'plan-mode-skipped':
      return 'Plan mode skipped';
    default:
      return signalId;
  }
}
