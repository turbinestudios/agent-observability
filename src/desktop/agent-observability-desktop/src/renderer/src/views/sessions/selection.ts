import { MAX_COMPARE_SESSIONS } from '../../../../shared/rpc';

/**
 * Which sessions are ticked for comparison.
 *
 * Held as `sessionKey()` strings rather than rows, so a selection is
 * independent of what the current search or source filter happens to be
 * showing: narrowing the list hides rows, it does not untick them.
 */

/** Add a key, or remove it when it is already there. Order is insertion order. */
export function toggleSelection(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];
}

export interface CompareState {
  count: number;
  canCompare: boolean;
  /** Why not, when `canCompare` is false and anything is selected at all. */
  reason?: string;
}

/** What the compare bar should say and whether its button is live. */
export function compareState(keys: readonly string[]): CompareState {
  const count = keys.length;
  if (count > MAX_COMPARE_SESSIONS) {
    return {
      count,
      canCompare: false,
      reason: `Comparing is limited to ${MAX_COMPARE_SESSIONS} sessions at a time.`,
    };
  }
  if (count < 2) {
    return { count, canCompare: false, reason: 'Select another session to compare.' };
  }
  return { count, canCompare: true };
}

/**
 * Whether the compare bar's "Review packet" button is live. Unlike Compare,
 * one ticked session is enough: a packet for a single session is the common
 * case, and several make one combined packet.
 */
export function packetState(keys: readonly string[]): { canBuild: boolean; reason?: string } {
  if (keys.length === 0) {
    return { canBuild: false };
  }
  if (keys.length > MAX_COMPARE_SESSIONS) {
    return { canBuild: false, reason: `A review packet covers at most ${MAX_COMPARE_SESSIONS} sessions.` };
  }
  return { canBuild: true };
}

/** `source:sessionId` keys back into refs. Source ids never contain a colon. */
export function refsFromKeys(keys: readonly string[]): { source: string; sessionId: string }[] {
  const refs: { source: string; sessionId: string }[] = [];
  for (const key of keys) {
    const at = key.indexOf(':');
    if (at > 0 && at < key.length - 1) {
      refs.push({ source: key.slice(0, at), sessionId: key.slice(at + 1) });
    }
  }
  return refs;
}
