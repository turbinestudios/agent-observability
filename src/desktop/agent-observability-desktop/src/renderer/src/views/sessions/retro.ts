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
