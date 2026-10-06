import {
  renderReviewPacketMarkdown,
  type ReviewPacketOptions,
} from '@agent-observability/core/src/analysis/reviewPacket';
import { renderHandoffBriefMarkdown } from '@agent-observability/core/src/analysis/handoffBrief';
import type { HandoffBrief, ReviewPacketResult } from '../../../../shared/rpc';

/**
 * Presentation logic for the review packet and the hand-off brief, split from
 * the dialogs so it tests under the node-only vitest setup. The datahost
 * returns the structured packet; rendering happens here with core's pure
 * functions, so the "Include what I asked" toggle re-renders without asking
 * the datahost again.
 */

/** GitHub rejects a pull request body longer than this. */
export const PR_BODY_LIMIT = 65_536;

/**
 * The fixed question the AI Helper door fills in. It must stay a constant: the
 * helper's notice lists what an attached session sends, and pasting packet
 * text here would send content that notice does not name.
 */
export const REVIEWER_PREFILL =
  'Summarize this session for someone about to review its changes: what was asked, what changed and why, what was verified, and what deserves a careful look.';

export function renderPacket(result: ReviewPacketResult, options: ReviewPacketOptions): string {
  return result.packets.length === 0 ? '' : renderReviewPacketMarkdown(result.packets, options);
}

export function renderHandoff(brief: HandoffBrief): string {
  return renderHandoffBriefMarkdown(brief);
}

export function packetStats(markdown: string): { chars: number; overPrLimit: boolean } {
  return { chars: markdown.length, overPrLimit: markdown.length > PR_BODY_LIMIT };
}

/** `12,345 characters`, grouped by hand so every machine prints the same. */
export function charCountLabel(chars: number): string {
  const grouped = String(chars).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return chars === 1 ? '1 character' : `${grouped} characters`;
}

/** The honest wording: strings were replaced, never "safe to share". */
export function redactionLabel(count: number): string | undefined {
  if (count <= 0) {
    return undefined;
  }
  return count === 1 ? '1 secret-looking string was replaced.' : `${count} secret-looking strings were replaced.`;
}

export function totalRedactions(result: ReviewPacketResult): number {
  return result.packets.reduce((sum, packet) => sum + packet.redactions, 0);
}

/** Which sessions can be resumed in the user's own terminal. */
export function canResumeInTerminal(source: string): boolean {
  return source === 'claude' || source === 'copilot-cli';
}
