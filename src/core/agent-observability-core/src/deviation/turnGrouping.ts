import { Interaction } from '../telemetry/models';

/**
 * Partition a session's interactions into per-turn buckets, aligned BY INDEX to
 * `turnStartsMs` — the `SessionTurn` anchor start times, ascending.
 *
 * Each interaction is assigned to the LAST turn whose start time is `<=` the
 * interaction's timestamp — the same timestamp-window attribution the detail
 * builder already uses for per-turn line counts (see `database.ts`). Interactions
 * earlier than the first turn start fall into turn 0 (the leading/synthetic turn).
 *
 * Why this exists: per-turn workflow analysis needs the real {@link Interaction}
 * metadata (`agentName`/`spanId`), but the turn ANCHOR rule lives in the DB layer
 * (it needs `conversation_id`/`chat_session_id`, which the safe `Interaction`
 * projection drops). Rather than re-derive anchors, we reuse the already-correct
 * turn start times the panel computes and bucket interactions by time. Pure, so
 * the detector stays headless and unit-testable.
 *
 * @param interactions the session's interactions (any order)
 * @param turnStartsMs ascending turn start timestamps (`SessionTurn.timestampMs`)
 * @returns one bucket per turn start (each possibly empty); `[]` when there are no turns
 */
export function groupInteractionsByTurn(
  interactions: readonly Interaction[],
  turnStartsMs: readonly number[],
): Interaction[][] {
  const buckets: Interaction[][] = turnStartsMs.map(() => []);
  if (buckets.length === 0) {
    return buckets;
  }
  for (const interaction of interactions) {
    let index = 0;
    for (let t = 0; t < turnStartsMs.length; t++) {
      if (turnStartsMs[t] <= interaction.timestampMs) {
        index = t;
      } else {
        break;
      }
    }
    buckets[index].push(interaction);
  }
  return buckets;
}
