import { useSyncExternalStore } from 'react';
import type { RunPrefillParams } from '../../../../shared/rpc';

/**
 * Doors into Run from other views.
 *
 * A door never sends anything. It asks the app shell to open the Run view
 * with a goal the data host builds from what the app already knows; the user
 * reads and edits that text and presses Start themselves. Doors exist only
 * while Run is turned on in Settings.
 *
 * A tiny window event carries the request, so a view deep in the tree can
 * offer a door without threading a callback through every parent. Only ids
 * travel on it: never text, never a path.
 */
export const RUN_DOOR_EVENT = 'ao-run-door';

export type RunDoorRequest = { prefill: RunPrefillParams } | { openSessionId: string };

export function openRunDoor(prefill: RunPrefillParams): void {
  window.dispatchEvent(new CustomEvent<RunDoorRequest>(RUN_DOOR_EVENT, { detail: { prefill } }));
}

/** Open the Run view on a session the app is already hosting. */
export function openRunSession(sessionId: string): void {
  window.dispatchEvent(new CustomEvent<RunDoorRequest>(RUN_DOOR_EVENT, { detail: { openSessionId: sessionId } }));
}

// Whether Run is on, shared so every door can hide itself without its own
// settings round trip. The app shell sets it; doors only read it.
let runEnabled = false;
const listeners = new Set<() => void>();

export function setRunEnabled(next: boolean): void {
  if (next !== runEnabled) {
    runEnabled = next;
    for (const listener of listeners) {
      listener();
    }
  }
}

export function isRunEnabled(): boolean {
  return runEnabled;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** True while Run is turned on. Doors render nothing otherwise. */
export function useRunEnabled(): boolean {
  return useSyncExternalStore(subscribe, isRunEnabled, () => false);
}
