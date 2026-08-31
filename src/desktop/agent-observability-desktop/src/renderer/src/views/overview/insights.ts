import type { ThemeRow, VerdictDayPoint } from '../../../../shared/rpc';
import type { SeriesStyle, StackedColumn } from './charts';

/**
 * Presentation rules for the Dashboard's insight section, split from the view
 * so they test under the node-only vitest setup like `views/sessions/retro.ts`.
 */

/**
 * Fixed verdict order, best to worst, with the coverage series last so it
 * stacks on top. Colors alias the retro chip ramp (see overview.css) — the
 * chart and the chips must never disagree about what a verdict looks like.
 * Labels match `verdictLabel` in `views/sessions/retro.ts`.
 */
export const VERDICT_SERIES: SeriesStyle[] = [
  { key: 'smooth', label: 'Went smoothly', colorVar: '--verdict-smooth' },
  { key: 'bumpy', label: 'Some friction', colorVar: '--verdict-bumpy' },
  { key: 'struggled', label: 'Struggled', colorVar: '--verdict-struggled' },
  { key: 'abandoned', label: 'Left unfinished', colorVar: '--verdict-abandoned' },
  { key: 'unjudged', label: 'Not analyzed', colorVar: '--verdict-unjudged' },
];

/**
 * Expand the sparse day × verdict rows into one stacked column per day bucket.
 *
 * The buckets come from the same `buildDays` walk the other charts use, so the
 * hero can never draw a different span than the chart below it; rows outside
 * the buckets (clock skew, future-dated) are dropped exactly as `buildDays`
 * drops theirs.
 */
export function verdictColumns(
  days: readonly { iso: string; short: string; long: string }[],
  points: readonly VerdictDayPoint[],
): StackedColumn[] {
  const byDay = new Map<string, Record<string, number>>();
  for (const point of points) {
    const record = byDay.get(point.day) ?? {};
    record[point.verdict] = (record[point.verdict] ?? 0) + point.sessions;
    byDay.set(point.day, record);
  }
  return days.map((day) => ({
    label: day.short,
    fullLabel: day.long,
    segments: VERDICT_SERIES.map((series) => ({
      key: series.key,
      value: byDay.get(day.iso)?.[series.key] ?? 0,
    })),
  }));
}

/** Tooltip line for a theme row: the detail behind its sessions figure. */
export function themeTitle(row: ThemeRow): string {
  const sessions = row.sessions === 1 ? '1 session' : `${row.sessions.toLocaleString()} sessions`;
  const occurrences =
    row.occurrences === 1 ? '1 occurrence' : `${row.occurrences.toLocaleString()} occurrences`;
  return `${occurrences} across ${sessions}`;
}
