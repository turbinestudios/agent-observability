import { describe, expect, it } from 'vitest';
import type { ToolRankingRow } from '../../../../shared/rpc';
import {
  TOOL_COLUMNS,
  defaultDescending,
  failureBarWidth,
  failureRate,
  formatFailureRate,
  formatToolDuration,
  groupCount,
  sortTools,
  toolsEmptyMessage,
  visibleTools,
} from './tools';

function tool(over: Partial<ToolRankingRow> & Pick<ToolRankingRow, 'tool'>): ToolRankingRow {
  return { calls: 10, failures: 0, sessions: 1, lastUsedMs: 0, maxMs: 0, p90Overflow: false, ...over };
}

describe('failure figures', () => {
  it('computes the rate, formats it by hand and sizes the bar', () => {
    const row = tool({ tool: 'Bash', calls: 8, failures: 1 });
    expect(failureRate(row)).toBe(0.125);
    expect(formatFailureRate(row)).toBe('12.5%');
    expect(failureBarWidth(row)).toBe(13);
    expect(formatFailureRate(tool({ tool: 'x', calls: 4, failures: 1 }))).toBe('25%');
    expect(formatFailureRate(tool({ tool: 'x', calls: 0, failures: 0 }))).toBe('0%');
    expect(failureBarWidth(tool({ tool: 'x', calls: 2, failures: 5 }))).toBe(100);
  });
});

describe('formatToolDuration', () => {
  it('prints milliseconds, seconds, overflow and the absence of data', () => {
    expect(formatToolDuration(250)).toBe('250 ms');
    expect(formatToolDuration(2000)).toBe('2 s');
    expect(formatToolDuration(2500)).toBe('2.5 s');
    expect(formatToolDuration(30000, true)).toBe('over 30 s');
    expect(formatToolDuration(undefined)).toBe('—');
  });
});

describe('groupCount', () => {
  it('groups thousands the same on every machine', () => {
    expect(groupCount(0)).toBe('0');
    expect(groupCount(999)).toBe('999');
    expect(groupCount(1234)).toBe('1,234');
    expect(groupCount(1234567)).toBe('1,234,567');
  });
});

describe('sortTools', () => {
  const rows = [
    tool({ tool: 'Read', calls: 30, failures: 0, p50Ms: 100, p90Ms: 250, lastUsedMs: 3 }),
    tool({ tool: 'Bash', calls: 20, failures: 5, p50Ms: 1000, p90Ms: 30000, p90Overflow: true, lastUsedMs: 9 }),
    tool({ tool: 'edit', calls: 20, failures: 1, lastUsedMs: 5 }),
  ];

  it('sorts by any column without mutating the input', () => {
    expect(sortTools(rows, 'calls', true).map((r) => r.tool)).toEqual(['Read', 'Bash', 'edit']);
    expect(sortTools(rows, 'failureRate', true).map((r) => r.tool)).toEqual(['Bash', 'edit', 'Read']);
    expect(sortTools(rows, 'tool', false).map((r) => r.tool)).toEqual(['Bash', 'edit', 'Read']);
    expect(sortTools(rows, 'p90', true)[0].tool).toBe('Bash');
    expect(sortTools(rows, 'p50', false)[0].tool).toBe('edit');
    expect(sortTools(rows, 'lastUsed', true)[0].tool).toBe('Bash');
    expect(rows.map((r) => r.tool)).toEqual(['Read', 'Bash', 'edit']);
  });

  it('breaks ties by calls then name, and starts numeric columns descending', () => {
    expect(sortTools(rows, 'sessions', true).map((r) => r.tool)).toEqual(['Read', 'Bash', 'edit']);
    expect(defaultDescending('tool')).toBe(false);
    expect(TOOL_COLUMNS.filter((c) => c.key !== 'tool').every((c) => defaultDescending(c.key))).toBe(true);
  });
});

describe('visibleTools and the empty message', () => {
  it('keeps only failing tools when asked and explains an empty table', () => {
    const rows = [tool({ tool: 'a', failures: 1 }), tool({ tool: 'b' })];
    expect(visibleTools(rows, true).map((r) => r.tool)).toEqual(['a']);
    expect(visibleTools(rows, false)).toHaveLength(2);
    expect(toolsEmptyMessage({ analyzed: 1, total: 1, running: false }, true, 2)).toContain('No tool failed');
    expect(toolsEmptyMessage({ analyzed: 0, total: 5, running: true }, false, 0)).toContain('Still reading');
    expect(toolsEmptyMessage(undefined, false, 0)).toContain('No tool calls');
  });
});
