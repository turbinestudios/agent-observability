import type { AnalysisStatus, ToolRankingRow } from '../../../../shared/rpc';

/**
 * Presentation rules for the Tools tab: sorting, hand-formatted figures and the
 * failure bar. Pure, so it tests without a window; numbers are formatted by
 * hand so every machine prints the same text.
 */

export type ToolSortKey = 'tool' | 'calls' | 'failures' | 'failureRate' | 'p50' | 'p90' | 'sessions' | 'lastUsed';

export const TOOL_COLUMNS: readonly { key: ToolSortKey; label: string; numeric: boolean; title?: string }[] = [
  { key: 'tool', label: 'Tool', numeric: false },
  { key: 'calls', label: 'Calls', numeric: true },
  { key: 'failures', label: 'Failed', numeric: true },
  {
    key: 'failureRate',
    label: 'Failure rate',
    numeric: true,
    title: 'Failed calls as a share of all calls. For Copilot this is a lower bound: a call recorded without a status counts as a success.',
  },
  {
    key: 'p50',
    label: 'Typical time',
    numeric: true,
    title: 'Approximate time to result for a typical call (half are faster). For Claude Code this includes any wait on a permission prompt.',
  },
  {
    key: 'p90',
    label: 'Slow time',
    numeric: true,
    title: 'Approximate time to result for a slow call (nine in ten are faster).',
  },
  { key: 'sessions', label: 'Sessions', numeric: true },
  { key: 'lastUsed', label: 'Last used', numeric: true },
];

/** Stated under the table: what the figures do and do not cover. */
export const TOOL_SCOPE_NOTE =
  'Claude Code figures cover tool calls on the main thread; calls made inside sub-agents are not included. ' +
  'Times are time to result, read off duration buckets, so they are approximate.';

/** Failed calls as a fraction of calls, 0 when the tool was never called. */
export function failureRate(row: Pick<ToolRankingRow, 'calls' | 'failures'>): number {
  return row.calls > 0 ? row.failures / row.calls : 0;
}

/** `12.5%`, `0%`, `100%`: one decimal only when it says something. */
export function formatFailureRate(row: Pick<ToolRankingRow, 'calls' | 'failures'>): string {
  const pct = Math.round(failureRate(row) * 1000) / 10;
  return Number.isInteger(pct) ? `${pct}%` : `${pct.toFixed(1)}%`;
}

/** Width of the failure bar, in percent of its track. */
export function failureBarWidth(row: Pick<ToolRankingRow, 'calls' | 'failures'>): number {
  return Math.min(100, Math.max(0, Math.round(failureRate(row) * 100)));
}

/** `250 ms`, `2 s`, `1.5 s`, `over 30 s`, or a dash when nothing was recorded. */
export function formatToolDuration(ms: number | undefined, overflow = false): string {
  if (ms === undefined) {
    return '—';
  }
  const text = ms < 1000 ? `${Math.round(ms)} ms` : `${trimDecimal(ms / 1000)} s`;
  return overflow ? `over ${text}` : text;
}

function trimDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/** Thousands grouped by hand (`12,345`), never by the machine's locale. */
export function groupCount(value: number): string {
  const digits = String(Math.max(0, Math.round(value)));
  let out = '';
  for (let i = 0; i < digits.length; i += 1) {
    if (i > 0 && (digits.length - i) % 3 === 0) {
      out += ',';
    }
    out += digits[i];
  }
  return out;
}

function sortValue(row: ToolRankingRow, key: ToolSortKey): number | string {
  switch (key) {
    case 'tool':
      return row.tool.toLowerCase();
    case 'calls':
      return row.calls;
    case 'failures':
      return row.failures;
    case 'failureRate':
      return failureRate(row);
    case 'p50':
      return row.p50Ms ?? -1;
    case 'p90':
      return (row.p90Ms ?? -1) + (row.p90Overflow ? 0.5 : 0);
    case 'sessions':
      return row.sessions;
    case 'lastUsed':
      return row.lastUsedMs;
  }
}

/**
 * Sort a copy of the rows. Ties fall back to calls, then the tool name, so
 * the order never flaps between two renders of the same data.
 */
export function sortTools(rows: readonly ToolRankingRow[], key: ToolSortKey, descending: boolean): ToolRankingRow[] {
  const direction = descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const av = sortValue(a, key);
    const bv = sortValue(b, key);
    if (av !== bv) {
      return (av < bv ? -1 : 1) * direction;
    }
    if (a.calls !== b.calls) {
      return b.calls - a.calls;
    }
    return a.tool < b.tool ? -1 : a.tool > b.tool ? 1 : 0;
  });
}

/** A column sorts descending first, except the name. */
export function defaultDescending(key: ToolSortKey): boolean {
  return key !== 'tool';
}

/** Rows the "failed only" toggle keeps. */
export function visibleTools(rows: readonly ToolRankingRow[], failedOnly: boolean): ToolRankingRow[] {
  return failedOnly ? rows.filter((row) => row.failures > 0) : [...rows];
}

/** What to say when the table is empty, and why. */
export function toolsEmptyMessage(status: AnalysisStatus | undefined, failedOnly: boolean, total: number): string {
  if (failedOnly && total > 0) {
    return 'No tool failed in this selection.';
  }
  if (status !== undefined && status.running) {
    return 'Still reading sessions. Tools appear here as the analysis works through them.';
  }
  return 'No tool calls recorded for this selection.';
}
