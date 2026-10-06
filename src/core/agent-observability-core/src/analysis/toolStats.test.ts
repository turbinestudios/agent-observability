import { describe, expect, it } from 'vitest';
import { LATENCY_BOUNDS_MS } from '../aggregate/models';
import type { Interaction } from '../telemetry/models';
import {
  TOOL_DURATION_BUCKETS,
  approxPercentile,
  durationBucket,
  foldToolStats,
  mergeToolStats,
  percentileOverflows,
} from './toolStats';

function call(over: Partial<Interaction>): Interaction {
  return {
    timestampMs: 0,
    sessionId: 's',
    traceId: 't',
    operation: 'execute_tool',
    agentName: 'a',
    agentMode: 'agent',
    model: 'm',
    toolName: 'Bash',
    durationMs: 50,
    success: true,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    repository: 'unknown',
    ...over,
  };
}

describe('durationBucket', () => {
  it('puts a duration in the first bound it does not exceed, and overflow last', () => {
    expect(durationBucket(0)).toBe(0);
    expect(durationBucket(LATENCY_BOUNDS_MS[0])).toBe(0);
    expect(durationBucket(LATENCY_BOUNDS_MS[0] + 1)).toBe(1);
    expect(durationBucket(LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1])).toBe(LATENCY_BOUNDS_MS.length - 1);
    expect(durationBucket(LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1] + 1)).toBe(LATENCY_BOUNDS_MS.length);
    expect(durationBucket(Number.NaN)).toBe(0);
    expect(durationBucket(-5)).toBe(0);
  });
});

describe('foldToolStats', () => {
  it('counts calls, failures and durations per tool and ignores non-tool operations', () => {
    const stats = foldToolStats([
      call({ toolName: 'Bash', durationMs: 50 }),
      call({ toolName: 'Bash', durationMs: 400, success: false }),
      call({ toolName: 'Read', durationMs: 10 }),
      call({ operation: 'chat', toolName: undefined, durationMs: 9000 }),
      call({ toolName: '  ' }),
      call({ toolName: undefined }),
    ]);
    expect(stats.map((s) => s.name)).toEqual(['Bash', 'Read']);
    const [bash] = stats;
    expect(bash).toMatchObject({ calls: 2, failures: 1, durationMsSum: 450, durationMsMax: 400 });
    expect(bash.buckets).toHaveLength(TOOL_DURATION_BUCKETS);
    expect(bash.buckets[0]).toBe(1);
    expect(bash.buckets[2]).toBe(1);
  });

  it('orders by calls, then by name, so the ranking never flaps', () => {
    const stats = foldToolStats([call({ toolName: 'b' }), call({ toolName: 'a' }), call({ toolName: 'c' }), call({ toolName: 'c' })]);
    expect(stats.map((s) => s.name)).toEqual(['c', 'a', 'b']);
  });
});

describe('mergeToolStats', () => {
  it('adds the same tool across sessions and keeps the worst duration', () => {
    const a = foldToolStats([call({ toolName: 'Bash', durationMs: 50 }), call({ toolName: 'Edit', durationMs: 20 })]);
    const b = foldToolStats([call({ toolName: 'Bash', durationMs: 40_000, success: false })]);
    const merged = mergeToolStats([a, b]);
    const bash = merged.find((s) => s.name === 'Bash');
    expect(bash).toMatchObject({ calls: 2, failures: 1, durationMsMax: 40_000 });
    expect(bash?.buckets[LATENCY_BOUNDS_MS.length]).toBe(1);
    // The inputs are not mutated.
    expect(a[0].calls).toBe(1);
  });
});

describe('approxPercentile', () => {
  it('answers with the bound of the bucket holding the p-th call', () => {
    const buckets = new Array<number>(TOOL_DURATION_BUCKETS).fill(0);
    buckets[0] = 5;
    buckets[3] = 4;
    buckets[TOOL_DURATION_BUCKETS - 1] = 1;
    expect(approxPercentile(buckets, 0.5)).toBe(LATENCY_BOUNDS_MS[0]);
    expect(approxPercentile(buckets, 0.9)).toBe(LATENCY_BOUNDS_MS[3]);
    expect(approxPercentile(buckets, 1)).toBe(LATENCY_BOUNDS_MS[LATENCY_BOUNDS_MS.length - 1]);
    expect(percentileOverflows(buckets, 1)).toBe(true);
    expect(percentileOverflows(buckets, 0.9)).toBe(false);
  });

  it('is undefined with no calls and tolerates a short or dirty bucket array', () => {
    expect(approxPercentile([], 0.5)).toBeUndefined();
    expect(percentileOverflows([], 0.5)).toBe(false);
    expect(approxPercentile([Number.NaN, 2], 0.5)).toBe(LATENCY_BOUNDS_MS[1]);
  });
});
