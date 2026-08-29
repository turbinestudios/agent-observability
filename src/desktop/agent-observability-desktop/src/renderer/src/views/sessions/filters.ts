import type { ListSessionsParams, SessionRow } from '../../../../shared/rpc';
import { formatDay, shortRepo, sourceLabel } from './format';

/**
 * What the session list is currently narrowed to, and how that reads on screen.
 *
 * Split from the view for the usual reason in this package — it tests under the
 * node-only vitest setup — but also because three surfaces have to agree about
 * it: the filter panel that sets it, the chips that show it, and the Dashboard
 * drill-down that arrives carrying one. A filter that is applied but not
 * visible, or visible but not clearable, is the failure mode worth designing
 * against: the user is left looking at a short list with no explanation.
 */

export interface SessionFilters {
  /** `undefined` is every source. */
  source?: string;
  repository?: string;
  /** Inclusive range over the session's end time. */
  endedAfterMs?: number;
  endedBeforeMs?: number;
  tag?: string;
}

/** Which dimension a chip clears. */
export type FilterKey = 'source' | 'repository' | 'date' | 'tag';

export interface FilterChip {
  key: FilterKey;
  /** Short enough for a 340px pane. */
  label: string;
  /** The full value, for a tooltip, when the label had to be shortened. */
  title?: string;
}

export const EMPTY_FILTERS: SessionFilters = {};

/**
 * The chips to show, in a fixed order so they do not reshuffle as filters are
 * added and removed.
 *
 * The source is deliberately absent: it already has its own always-visible chip
 * row, and a second chip for it would read as two separate filters.
 */
export function filterChips(filters: SessionFilters, nowMs: number = Date.now()): FilterChip[] {
  const chips: FilterChip[] = [];
  if (filters.repository !== undefined) {
    chips.push({ key: 'repository', label: shortRepo(filters.repository), title: filters.repository });
  }
  const date = dateLabel(filters, nowMs);
  if (date !== undefined) {
    chips.push({ key: 'date', label: date });
  }
  if (filters.tag !== undefined) {
    chips.push({ key: 'tag', label: `#${filters.tag}`, title: `Tagged "${filters.tag}"` });
  }
  return chips;
}

/**
 * How a date range reads on a chip: one day is named once, an open end says
 * which end is open, so "before 7 Aug" is never mistaken for "on 7 Aug".
 */
export function dateLabel(filters: SessionFilters, nowMs: number = Date.now()): string | undefined {
  const { endedAfterMs: from, endedBeforeMs: to } = filters;
  if (from === undefined && to === undefined) {
    return undefined;
  }
  if (from !== undefined && to !== undefined) {
    const start = formatDay(from, nowMs);
    const end = formatDay(to, nowMs);
    return start === end ? start : `${start} – ${end}`;
  }
  return from !== undefined ? `From ${formatDay(from, nowMs)}` : `Until ${formatDay(to!, nowMs)}`;
}

/** Whether anything beyond the source chips is narrowing the list. */
export function hasFilters(filters: SessionFilters): boolean {
  return filterChips(filters).length > 0;
}

/** Drop one dimension, leaving the rest. Both date bounds clear together. */
export function clearFilter(filters: SessionFilters, key: FilterKey): SessionFilters {
  const next = { ...filters };
  if (key === 'date') {
    delete next.endedAfterMs;
    delete next.endedBeforeMs;
  } else {
    delete next[key];
  }
  return next;
}

/**
 * The whole local day containing `epochMs` — what clicking one column of the
 * Dashboard's per-day charts should open.
 */
export function dayRange(epochMs: number): Pick<SessionFilters, 'endedAfterMs' | 'endedBeforeMs'> {
  const start = new Date(epochMs);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { endedAfterMs: start.getTime(), endedBeforeMs: end.getTime() };
}

/** The same for a `YYYY-MM-DD` day key, as the overview's series reports them. */
export function isoDayRange(iso: string): Pick<SessionFilters, 'endedAfterMs' | 'endedBeforeMs'> {
  const [year, month, day] = iso.split('-').map(Number);
  return dayRange(new Date(year, month - 1, day).getTime());
}

/**
 * A stable identity for a filter set.
 *
 * The list's re-query effect depends on this rather than the object, which is a
 * fresh reference on every render and would re-query forever.
 */
export function filterKey(filters: SessionFilters): string {
  return [
    filters.source ?? '',
    filters.repository ?? '',
    filters.endedAfterMs ?? '',
    filters.endedBeforeMs ?? '',
    filters.tag ?? '',
  ].join('|');
}

/** Describe the active filters for an empty-state line. */
export function describeFilters(filters: SessionFilters, nowMs: number = Date.now()): string {
  const parts: string[] = [];
  if (filters.source !== undefined) {
    parts.push(sourceLabel(filters.source));
  }
  parts.push(...filterChips(filters, nowMs).map((chip) => chip.label));
  return parts.join(' · ');
}

/**
 * Merge an incoming drill-down over the current filters.
 *
 * A REPLACEMENT of the narrowing dimensions, not a merge into them: arriving
 * from "click this repository" must not silently inherit a tag the user set
 * twenty minutes ago on another screen, or the list shows fewer sessions than
 * the bar that was clicked. Search text and the state chips are separate
 * controls and are left alone.
 */
export function applyIntent(intent: SessionFilters): SessionFilters {
  const next: SessionFilters = {};
  if (intent.source !== undefined) {
    next.source = intent.source;
  }
  if (intent.repository !== undefined) {
    next.repository = intent.repository;
  }
  if (intent.endedAfterMs !== undefined) {
    next.endedAfterMs = intent.endedAfterMs;
  }
  if (intent.endedBeforeMs !== undefined) {
    next.endedBeforeMs = intent.endedBeforeMs;
  }
  if (intent.tag !== undefined) {
    next.tag = intent.tag;
  }
  return next;
}

/** The filters as the list RPC wants them. */
export function toListParams(filters: SessionFilters): ListSessionsParams {
  return { ...filters };
}

/**
 * Whether a row belongs in a list narrowed by these filters.
 *
 * Every dimension here is decidable from the row itself — tags included, since
 * a pushed row carries them — which is what lets the live update merge a row in
 * place, and take one OUT when an edit means it no longer qualifies. Without
 * the second half, removing a tag while filtered to it would leave the row
 * sitting in a list it no longer belongs to until something forced a re-query.
 *
 * This deliberately does NOT cover the search text or the Flagged/Struggled
 * chips: those are decided by SQL and by the background analysis respectively,
 * and reproducing either here would be a second copy of a predicate that can
 * drift from the real one.
 */
export function matchesFilters(row: SessionRow, filters: SessionFilters): boolean {
  if (filters.source !== undefined && filters.source.length > 0 && row.source !== filters.source) {
    return false;
  }
  if (
    filters.repository !== undefined &&
    filters.repository.length > 0 &&
    row.repository !== filters.repository
  ) {
    return false;
  }
  if (filters.endedAfterMs !== undefined && row.endedAtMs < filters.endedAfterMs) {
    return false;
  }
  if (filters.endedBeforeMs !== undefined && row.endedAtMs > filters.endedBeforeMs) {
    return false;
  }
  if (filters.tag !== undefined && filters.tag.length > 0) {
    const needle = filters.tag.toLowerCase();
    return (row.tags ?? []).some((tag) => tag.toLowerCase() === needle);
  }
  return true;
}
