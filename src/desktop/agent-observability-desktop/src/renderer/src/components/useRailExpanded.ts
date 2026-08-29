import { useCallback, useEffect, useState } from 'react';

/**
 * Whether the sidebar shows its labels.
 *
 * Expanded is the default: the icons are the app's own invention, and a
 * first-time user has no way to know what a flame or a looping arrow leads to
 * without hovering each one in turn. People who already know the icons — or who
 * want the pixels back for the session list — collapse it to the icon strip,
 * and that choice is remembered across restarts.
 *
 * Persistence is best-effort, exactly like the theme: a context with storage
 * disabled still works, it just opens expanded every time.
 */

const STORAGE_KEY = 'agent-observability.rail';

function readStored(): boolean {
  try {
    // Only an explicit collapse is stored; anything else means the default.
    return window.localStorage.getItem(STORAGE_KEY) !== 'collapsed';
  } catch {
    return true;
  }
}

function persist(expanded: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, expanded ? 'expanded' : 'collapsed');
  } catch {
    // Storage unavailable; the choice still applies for this run.
  }
}

export function useRailExpanded(): { expanded: boolean; toggle: () => void } {
  const [expanded, setExpanded] = useState<boolean>(readStored);

  useEffect(() => persist(expanded), [expanded]);

  const toggle = useCallback(() => setExpanded((current) => !current), []);

  return { expanded, toggle };
}
