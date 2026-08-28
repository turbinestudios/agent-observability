import type { CancellationToken } from '@agent-observability/core/src/chat/backends/cancellation';

/**
 * Datahost-side cancellation sources for CLI runs, implementing core's
 * host-neutral {@link CancellationToken}. Shared by the deep retrospective
 * (timeout only) and the AI Helper (Stop button plus a safety timeout).
 */

interface TokenState {
  cancelled: boolean;
  listeners: Set<(e: unknown) => unknown>;
}

function tokenOver(state: TokenState): CancellationToken {
  return {
    get isCancellationRequested() {
      return state.cancelled;
    },
    onCancellationRequested(listener) {
      state.listeners.add(listener);
      return { dispose: () => state.listeners.delete(listener) };
    },
  };
}

function fire(state: TokenState): void {
  if (state.cancelled) {
    return;
  }
  state.cancelled = true;
  for (const listener of state.listeners) {
    listener(undefined);
  }
}

/** A token that cancels itself after `ms` — the CLI is killed through it. */
export function timeoutToken(ms: number): { token: CancellationToken; dispose: () => void } {
  const state: TokenState = { cancelled: false, listeners: new Set() };
  const timer = setTimeout(() => fire(state), ms);
  return { token: tokenOver(state), dispose: () => clearTimeout(timer) };
}

/** A token cancelled by calling `cancel()` — the Stop button's handle. */
export function manualToken(): { token: CancellationToken; cancel: () => void } {
  const state: TokenState = { cancelled: false, listeners: new Set() };
  return { token: tokenOver(state), cancel: () => fire(state) };
}
