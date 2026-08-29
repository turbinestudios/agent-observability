import type { ListSessionsParams, OverviewWindow } from '../../../../shared/rpc';
import { DEFAULT_OVERVIEW_WINDOW, toOverviewWindow, windowStartMs } from '../../../../shared/rpc';

/**
 * The Dashboard's time window: how it is labelled, how it is remembered, and
 * what date range a drill-down out of it carries.
 *
 * Split from the view so it can be tested in this package's node-only vitest
 * setup, the same way `views/sessions/retro.ts` and `views/hotspots/hotspots.ts`
 * are — a component here would drag in the data-host client, which touches
 * `window` at module load.
 */

const STORAGE_KEY = 'agent-observability.overviewWindow';

/**
 * Persistence is best-effort, matching the theme's: a context with storage
 * disabled still works, it just opens on the default window each time.
 */
export function readStoredWindow(): OverviewWindow {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    // Numbers survive a round trip as strings; 'all' is already one.
    return toOverviewWindow(stored === 'all' ? stored : Number(stored));
  } catch {
    return DEFAULT_OVERVIEW_WINDOW;
  }
}

export function persistWindow(value: OverviewWindow): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(value));
  } catch {
    // Storage unavailable; the choice still applies for this run.
  }
}

/** What the segmented control shows. Short, because there are four of them. */
export function windowLabel(value: OverviewWindow): string {
  return value === 'all' ? 'All time' : `${value}d`;
}

/** The same, spelled out — for prose and for a filter chip. */
export function windowDescription(value: OverviewWindow): string {
  return value === 'all' ? 'all time' : `the last ${value} days`;
}

/**
 * The date range a drill-down out of the Dashboard has to carry.
 *
 * Without it, clicking a repository whose bar reads 12 would open a list of
 * every session that repository ever had — which reads as a bug, not as a
 * different question. `'all'` carries no range, because it excludes nothing.
 */
export function windowRange(
  value: OverviewWindow,
  now: number = Date.now(),
): Pick<ListSessionsParams, 'endedAfterMs'> {
  return value === 'all' ? {} : { endedAfterMs: windowStartMs(value, now) };
}
