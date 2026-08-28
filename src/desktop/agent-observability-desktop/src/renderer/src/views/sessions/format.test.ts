import { describe, it, expect } from 'vitest';
import { formatCost, formatDuration, formatRelative, formatTokens, sourceLabel, splitNotes } from './format';

describe('splitNotes', () => {
  it('returns nothing for an absent message', () => {
    expect(splitNotes(undefined)).toEqual([]);
  });

  it('keeps a single note intact', () => {
    expect(splitNotes('Copilot: No Copilot database found on this machine')).toEqual([
      'Copilot: No Copilot database found on this machine',
    ]);
  });

  it('splits multiple notes on the datahost joiner', () => {
    expect(splitNotes('Claude Code is turned off in Settings · Copilot: locked')).toEqual([
      'Claude Code is turned off in Settings',
      'Copilot: locked',
    ]);
  });
});

describe('formatTokens', () => {
  it('shows exact counts below a thousand', () => {
    expect(formatTokens(0)).toBe('0 tokens');
    expect(formatTokens(999)).toBe('999 tokens');
  });

  it('abbreviates thousands and millions without a trailing .0', () => {
    expect(formatTokens(1000)).toBe('1k tokens');
    expect(formatTokens(1500)).toBe('1.5k tokens');
    expect(formatTokens(2_000_000)).toBe('2M tokens');
  });

  it('treats missing or negative totals as zero', () => {
    expect(formatTokens(Number.NaN)).toBe('0 tokens');
    expect(formatTokens(-5)).toBe('0 tokens');
  });
});

describe('formatCost', () => {
  it('renders nothing for an absent cost — unknown is not free', () => {
    expect(formatCost(undefined)).toBe('');
    expect(formatCost(null)).toBe('');
    expect(formatCost(Number.NaN)).toBe('');
    expect(formatCost(-5)).toBe('');
  });

  it('keeps a genuine zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
  });

  it('floors tiny costs at <$0.01 rather than rounding them invisible', () => {
    expect(formatCost(4_200)).toBe('<$0.01');
  });

  it('shows cents below a thousand dollars and whole dollars above', () => {
    expect(formatCost(423_000)).toBe('$0.42');
    expect(formatCost(12_340_000)).toBe('$12.34');
    expect(formatCost(1_234_000_000)).toBe('$1,234');
  });
});

describe('formatDuration', () => {
  it('scales from seconds to hours', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(12 * 60_000)).toBe('12m');
    expect(formatDuration(65 * 60_000)).toBe('1h 5m');
  });

  it('drops the minutes part on a whole hour', () => {
    expect(formatDuration(120 * 60_000)).toBe('2h');
  });

  it('renders a dash when there is no duration', () => {
    expect(formatDuration(0)).toBe('—');
  });
});

describe('formatRelative', () => {
  const now = Date.UTC(2026, 4, 20, 12, 0, 0);

  it('collapses the last minute to "now"', () => {
    expect(formatRelative(now - 30_000, now)).toBe('now');
  });

  it('counts minutes, hours, then days', () => {
    expect(formatRelative(now - 14 * 60_000, now)).toBe('14m');
    expect(formatRelative(now - 3 * 3_600_000, now)).toBe('3h');
    expect(formatRelative(now - 3 * 86_400_000, now)).toBe('3d');
  });

  it('names yesterday rather than showing "1d"', () => {
    expect(formatRelative(now - 26 * 3_600_000, now)).toBe('yesterday');
  });

  it('falls back to a date beyond a week', () => {
    // Exact text is locale-dependent; what matters is that it stops being relative.
    expect(formatRelative(now - 40 * 86_400_000, now)).not.toMatch(/^\d+[dhm]$/);
  });

  it('renders nothing for a missing timestamp', () => {
    expect(formatRelative(0, now)).toBe('');
  });
});

describe('sourceLabel', () => {
  it('maps known source ids to display names', () => {
    expect(sourceLabel('claude')).toBe('Claude Code');
    expect(sourceLabel('copilot-cloud')).toBe('Copilot Cloud');
  });

  it('passes an unknown source through rather than hiding it', () => {
    expect(sourceLabel('future-agent')).toBe('future-agent');
  });
});
