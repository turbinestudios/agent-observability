import { describe, expect, it } from 'vitest';
import { PENDING_TOOL_HINT_MS } from '@agent-observability/core/src/live/liveStatus';
import type { LiveSessionRow } from '../../../../shared/rpc';
import {
  agentLabel,
  kindLabel,
  liveSummary,
  pendingHint,
  sortLiveRows,
  statusLabel,
  trend,
  verdictShare,
} from './workspace';

function row(overrides: Partial<LiveSessionRow> = {}): LiveSessionRow {
  return {
    source: 'claude',
    sessionId: 's',
    repository: 'https://github.com/o/r',
    status: 'working',
    lastEvent: 'user-prompt',
    startedAtMs: 1_000,
    lastActivityMs: 2_000,
    pendingTools: [],
    inputTokens: 0,
    outputTokens: 0,
    countsIndexedAtMs: 0,
    ...overrides,
  };
}

describe('sortLiveRows', () => {
  it('orders waiting before working before idle before finished, then by recency', () => {
    const sorted = sortLiveRows([
      row({ sessionId: 'f', status: 'finished', lastActivityMs: 9 }),
      row({ sessionId: 'w1', status: 'working', lastActivityMs: 5 }),
      row({ sessionId: 'i', status: 'idle', lastActivityMs: 7 }),
      row({ sessionId: 'a', status: 'waiting', lastActivityMs: 1 }),
      row({ sessionId: 'w2', status: 'working', lastActivityMs: 8 }),
    ]);
    expect(sorted.map((r) => r.sessionId)).toEqual(['a', 'w2', 'w1', 'i', 'f']);
  });
});

describe('statusLabel and summary', () => {
  it('names every status', () => {
    expect(statusLabel('waiting')).toBe('Waiting for you');
    expect(statusLabel('working')).toBe('Working');
    expect(statusLabel('idle')).toBe('Idle');
    expect(statusLabel('finished')).toBe('Finished');
  });

  it('summarises counts in status order and says when nothing runs', () => {
    expect(liveSummary([])).toBe('Nothing running');
    expect(
      liveSummary([row({ status: 'working' }), row({ status: 'waiting' }), row({ status: 'working' })]),
    ).toBe('1 waiting for you · 2 working');
  });
});

describe('pendingHint', () => {
  it('appears only for a long-pending tool call on a working session', () => {
    const pending = row({ lastEvent: 'tool-pending', pendingTools: ['Bash'], lastActivityMs: 0 });
    expect(pendingHint(pending, PENDING_TOOL_HINT_MS - 1)).toBeUndefined();
    expect(pendingHint(pending, PENDING_TOOL_HINT_MS)).toContain('Bash call pending for 1 min');
    expect(pendingHint(pending, 5 * 60_000)).toContain('5 min');
    expect(pendingHint({ ...pending, lastEvent: 'assistant-text' }, 5 * 60_000)).toBeUndefined();
    expect(pendingHint({ ...pending, status: 'idle' }, 5 * 60_000)).toBeUndefined();
  });

  it('speaks generically when several calls are pending', () => {
    const pending = row({ lastEvent: 'tool-pending', pendingTools: ['Read', 'Grep'], lastActivityMs: 0 });
    expect(pendingHint(pending, 2 * 60_000)).toContain('tool call pending');
  });
});

describe('trend', () => {
  it('formats the delta by hand on every machine', () => {
    expect(trend(5, 2)).toEqual({ delta: 3, label: '+3' });
    expect(trend(2, 5)).toEqual({ delta: -3, label: '-3' });
    expect(trend(4, 4)).toEqual({ delta: 0, label: 'no change' });
  });
});

describe('labels', () => {
  it('maps inventory kinds and agents to words', () => {
    expect(kindLabel('rule')).toBe('Rule');
    expect(kindLabel('something-new')).toBe('something-new');
    expect(agentLabel('shared')).toBe('Both');
    expect(agentLabel('claude')).toBe('Claude Code');
  });
});

describe('verdictShare', () => {
  it('reports every verdict in display order with rounded percentages', () => {
    const shares = verdictShare({ smooth: 3, bumpy: 1, struggled: 0, abandoned: 0, unjudged: 0 });
    expect(shares.map((s) => s.key)).toEqual(['smooth', 'bumpy', 'struggled', 'abandoned', 'unjudged']);
    expect(shares[0]).toEqual({ key: 'smooth', value: 3, pct: 75 });
    expect(shares[1].pct).toBe(25);
  });

  it('is all zeros for an empty repository', () => {
    expect(verdictShare({ smooth: 0, bumpy: 0, struggled: 0, abandoned: 0, unjudged: 0 }).every((s) => s.pct === 0)).toBe(
      true,
    );
  });
});
