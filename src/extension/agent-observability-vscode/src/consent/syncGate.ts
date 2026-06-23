/**
 * The cloud-sync gate, as a pure function with no `vscode` dependency so the
 * privacy-critical decision is unit-testable headless and has a SINGLE
 * authoritative implementation (consumed by {@link ./consentManager.ConsentManager.canSync}
 * and the `syncNow` command / Phase 7 sync engine).
 *
 * Sharing is permitted ONLY when the user has explicitly consented AND an
 * organization API key is present — both are required by the Phase 4 exit
 * criteria and by `api-auth.md`.
 */

/** Inputs to the sync gate decision. */
export interface SyncGateState {
  /** Whether the user has opted in to cloud sharing (default false = opt-out). */
  consented: boolean;
  /** Whether an organization API key is stored in SecretStorage. */
  hasApiKey: boolean;
}

/** True only when both gates are satisfied. */
export function computeCanSync(state: SyncGateState): boolean {
  return state.consented && state.hasApiKey;
}

/**
 * A user-facing explanation of WHY sync is blocked, or `undefined` when sync is
 * allowed. Never includes any secret value.
 */
export function describeSyncBlock(state: SyncGateState): string | undefined {
  if (computeCanSync(state)) {
    return undefined;
  }
  if (!state.consented && !state.hasApiKey) {
    return 'Cloud sharing is off and no organization API key is set. Enable sharing and set a key to sync.';
  }
  if (!state.consented) {
    return 'Cloud sharing is off. Enable it to sync aggregate statistics.';
  }
  return 'No organization API key is set. Add your key to sync.';
}
