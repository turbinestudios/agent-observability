import type { CostMode } from '@agent-observability/core/src/telemetry/models';

/**
 * Picks the single cost basis a combined view renders on.
 *
 * A session's cost is expressed in whatever unit its source bills in — Claude
 * Code in token-priced dollars, local Copilot in AIU, cloud Copilot in credits
 * — and the combined document has one cost tile. The merged totals carry all
 * three units side by side, but only the one matching the chosen basis is
 * shown, so a mixed selection has a real omission to declare.
 *
 * Tokens, turns, tool calls and lines of code are unit-free and stay exact
 * whatever this returns; only the cost figure is affected.
 */

/** What choosing a basis needs to know about one selected session. */
export interface CostSource {
  costMode: CostMode;
  /** The source's display name, for the note. */
  label: string;
  startedAtMs: number;
}

export interface CostBasis {
  costMode: CostMode;
  /** Set only when the selection spans more than one basis. */
  note?: string;
}

/** How each basis is named to a user, and what its figure is called. */
const BASIS_NAME: Record<CostMode, string> = {
  usd: 'US dollars',
  aiu: 'AIU',
  credits: 'credits',
};

/**
 * The basis held by the most sessions wins, so the cost tile describes as much
 * of the selection as it can. Ties go to the earliest-started session's basis —
 * arbitrary, but fixed, so the same selection always renders the same way.
 */
export function chooseCostBasis(sessions: readonly CostSource[]): CostBasis {
  if (sessions.length === 0) {
    return { costMode: 'aiu' };
  }

  const counts = new Map<CostMode, number>();
  for (const s of sessions) {
    counts.set(s.costMode, (counts.get(s.costMode) ?? 0) + 1);
  }

  const earliest = [...sessions].sort((a, b) => a.startedAtMs - b.startedAtMs)[0];
  let costMode = earliest.costMode;
  for (const [mode, count] of counts) {
    if (count > (counts.get(costMode) ?? 0)) {
      costMode = mode;
    }
  }

  if (counts.size === 1) {
    return { costMode };
  }

  const kept = [...new Set(sessions.filter((s) => s.costMode === costMode).map((s) => s.label))].sort();
  const dropped = [...new Set(sessions.filter((s) => s.costMode !== costMode).map((s) => s.label))].sort();

  return {
    costMode,
    note:
      `Cost is shown in ${BASIS_NAME[costMode]}, the basis used by ${list(kept)}. ` +
      `${list(dropped)} ${dropped.length === 1 ? 'bills' : 'bill'} differently, so ${
        dropped.length === 1 ? 'its' : 'their'
      } sessions ` +
      'count towards the tokens, turns and lines of code here but not towards the cost.',
  };
}

/** "A", "A and B", "A, B and C" — for prose, not markup. */
function list(labels: readonly string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? '';
  }
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}
