import { describe, it, expect } from 'vitest';
import { buildBatch, floorToBucketMs, AggregationRow, BuildBatchInput } from './aggregator';
import { LATENCY_BOUNDS_MS, BUCKET_DURATION_SECONDS } from './models';

/**
 * Aggregator correctness + determinism tests over synthetic rows. No DB, no
 * vscode — pure transform.
 */

const DEV_ID = 'dev_0123456789abcdef0123456789abcdef';
const REPO = 'https://github.com/example-org/sample-repo';

/** Two fixed 30-min bins on a clean UTC boundary. */
const BIN0 = Date.parse('2026-06-02T08:00:00.000Z'); // bucketStart for [08:00,08:30)
const BIN1 = Date.parse('2026-06-02T08:30:00.000Z'); // bucketStart for [08:30,09:00)

function row(overrides: Partial<AggregationRow>): AggregationRow {
  return {
    startTimeMs: BIN0 + 60_000,
    sessionKey: 's1',
    repository: REPO,
    model: 'gpt-4.1',
    agentMode: 'agent',
    operation: 'chat',
    toolName: undefined,
    durationMs: 300,
    statusCode: 1,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    ...overrides,
  };
}

function build(rows: AggregationRow[], extra?: Partial<BuildBatchInput>) {
  return buildBatch({
    rows,
    pseudonymousDeveloperId: DEV_ID,
    toolVersion: '1.4.2',
    windowStartMs: BIN0,
    windowEndMs: BIN1 + 30 * 60_000,
    generatedAtMs: Date.parse('2026-06-02T09:30:00.000Z'),
    ...extra,
  });
}

describe('floorToBucketMs', () => {
  it('floors to the 30-minute UTC boundary', () => {
    expect(floorToBucketMs(BIN0 + 60_000)).toBe(BIN0);
    expect(floorToBucketMs(BIN0 + 29 * 60_000 + 59_999)).toBe(BIN0);
    expect(floorToBucketMs(BIN1)).toBe(BIN1);
    expect(floorToBucketMs(BIN1 + 1)).toBe(BIN1);
  });
});

describe('buildBatch — binning + grain', () => {
  it('bins rows into 30-minute buckets aligned to {00,30} minutes, seconds=0', () => {
    const batch = build([
      row({ startTimeMs: BIN0 + 5_000 }),
      row({ startTimeMs: BIN0 + 29 * 60_000 }),
      row({ startTimeMs: BIN1 + 60_000 }),
    ]);
    // Two distinct bins => two buckets (same other grain dimensions).
    expect(batch.buckets).toHaveLength(2);
    for (const b of batch.buckets) {
      expect(b.bucketDurationSeconds).toBe(BUCKET_DURATION_SECONDS);
      const d = new Date(b.bucketStart);
      expect([0, 30]).toContain(d.getUTCMinutes());
      expect(d.getUTCSeconds()).toBe(0);
      expect(d.getUTCMilliseconds()).toBe(0);
      expect(b.bucketStart.endsWith('Z')).toBe(true);
    }
    expect(batch.buckets[0].bucketStart).toBe('2026-06-02T08:00:00.000Z');
    expect(batch.buckets[0].interactionCount).toBe(2);
    expect(batch.buckets[1].bucketStart).toBe('2026-06-02T08:30:00.000Z');
    expect(batch.buckets[1].interactionCount).toBe(1);
  });

  it('separates buckets by grain (model/agentMode/operation/toolName) within one bin', () => {
    const batch = build([
      row({ model: 'gpt-4.1' }),
      row({ model: 'claude' }),
      row({ operation: 'execute_tool', toolName: 'read_file' }),
      row({ operation: 'execute_tool', toolName: 'custom' }),
    ]);
    expect(batch.buckets).toHaveLength(4);
  });

  it('SKIPS rows whose operation is outside the enum (never invents a value)', () => {
    const batch = build([
      row({ operation: 'chat' }),
      row({ operation: 'totally_unknown_op' }),
      row({ operation: '' }),
    ]);
    const totalInteractions = batch.buckets.reduce((s, b) => s + b.interactionCount, 0);
    expect(totalInteractions).toBe(1);
    for (const b of batch.buckets) {
      expect(['chat', 'execute_tool', 'execute_hook', 'invoke_agent']).toContain(b.operation);
    }
  });

  it('only sets toolName for execute_tool buckets', () => {
    const batch = build([
      row({ operation: 'chat', toolName: 'read_file' }),
      row({ operation: 'execute_tool', toolName: 'read_file' }),
    ]);
    const chat = batch.buckets.find((b) => b.operation === 'chat');
    const tool = batch.buckets.find((b) => b.operation === 'execute_tool');
    expect(chat?.toolName).toBeUndefined();
    expect(tool?.toolName).toBe('read_file');
  });
});

describe('buildBatch — measures', () => {
  it('computes counts, token sums, success/error partition, and durationMsSum', () => {
    const batch = build([
      row({ statusCode: 1, durationMs: 300, inputTokens: 100, outputTokens: 10, cachedTokens: 5 }),
      row({ statusCode: 0, durationMs: 700, inputTokens: 200, outputTokens: 20, cachedTokens: 50 }),
      row({ statusCode: 2, durationMs: 1500, inputTokens: 50, outputTokens: 5, cachedTokens: 0 }),
    ]);
    expect(batch.buckets).toHaveLength(1);
    const b = batch.buckets[0];
    expect(b.interactionCount).toBe(3);
    // status 0 and 1 => success; status 2 => error.
    expect(b.successCount).toBe(2);
    expect(b.errorCount).toBe(1);
    expect(b.successCount + b.errorCount).toBe(b.interactionCount);
    expect(b.inputTokens).toBe(350);
    expect(b.outputTokens).toBe(35);
    expect(b.cachedTokens).toBe(55);
    expect(b.durationMsSum).toBe(2500);
  });

  it('builds a length-9 histogram whose counts sum to interactionCount', () => {
    const durations = [50, 100, 101, 250, 300, 1000, 2001, 9999, 30001, 60000];
    const batch = build(durations.map((d) => row({ durationMs: d })));
    const b = batch.buckets[0];
    expect(b.latencyHistogram.boundsMs).toEqual([...LATENCY_BOUNDS_MS]);
    expect(b.latencyHistogram.counts).toHaveLength(LATENCY_BOUNDS_MS.length + 1);
    const sum = b.latencyHistogram.counts.reduce((s, c) => s + c, 0);
    expect(sum).toBe(b.interactionCount);
    expect(sum).toBe(durations.length);
    // 50 & 100 -> <=100 bucket(0); 101 & 250 -> <=250 bucket(1); etc.
    expect(b.latencyHistogram.counts[0]).toBe(2); // 50,100
    // 30001 and 60000 both exceed the largest bound (30000) -> +Inf overflow.
    expect(b.latencyHistogram.counts[LATENCY_BOUNDS_MS.length]).toBe(2); // 30001,60000
  });

  it('counts distinctSessionCount per bucket and records lastActivityAtMs as the max start', () => {
    const batch = build([
      row({ sessionKey: 'a', startTimeMs: BIN0 + 1_000 }),
      row({ sessionKey: 'a', startTimeMs: BIN0 + 2_000 }),
      row({ sessionKey: 'b', startTimeMs: BIN0 + 9_000 }),
    ]);
    const b = batch.buckets[0];
    expect(b.distinctSessionCount).toBe(2);
    expect(b.lastActivityAtMs).toBe(BIN0 + 9_000);
  });

  it('omits reasoningTokens when zero/absent and includes it when present', () => {
    const without = build([row({ reasoningTokens: 0 })]).buckets[0];
    expect(without.reasoningTokens).toBeUndefined();
    const withR = build([row({ reasoningTokens: 42 }), row({ reasoningTokens: 8 })]).buckets[0];
    expect(withR.reasoningTokens).toBe(50);
  });
});

describe('buildBatch — envelope + determinism', () => {
  it('emits the fixed envelope fields and ISO window (closed-open)', () => {
    const batch = build([row({})]);
    expect(batch.schemaVersion).toBe('1.0');
    expect(batch.toolVersion).toBe('1.4.2');
    expect(batch.pseudonymousDeveloperId).toBe(DEV_ID);
    expect(batch.window.start).toBe('2026-06-02T08:00:00.000Z');
    expect(new Date(batch.window.end).getTime()).toBeGreaterThan(
      new Date(batch.window.start).getTime(),
    );
    expect(batch.generatedAt).toBe('2026-06-02T09:30:00.000Z');
  });

  it('rowKey is deterministic SHA-256 hex and stable across runs (idempotent)', () => {
    const rows = [row({}), row({ model: 'claude' })];
    const a = build(rows);
    const b = build(rows);
    expect(a.buckets.map((x) => x.rowKey)).toEqual(b.buckets.map((x) => x.rowKey));
    for (const bucket of a.buckets) {
      expect(bucket.rowKey).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('batchId is deterministic for the same developer + window (idempotent)', () => {
    const a = build([row({})]);
    const b = build([row({ inputTokens: 999 })]); // different measures, same window/dev
    expect(a.batchId).toBe(b.batchId);
    expect(a.batchId).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces identical buckets regardless of input row ordering', () => {
    const rows = [
      row({ startTimeMs: BIN1 + 1_000, model: 'claude' }),
      row({ startTimeMs: BIN0 + 1_000, model: 'gpt-4.1' }),
      row({ startTimeMs: BIN0 + 2_000, model: 'gpt-4.1' }),
    ];
    const forward = build(rows);
    const reversed = build([...rows].reverse());
    expect(forward.buckets.map((b) => b.rowKey)).toEqual(reversed.buckets.map((b) => b.rowKey));
    expect(forward.batchId).toBe(reversed.batchId);
  });

  it('returns an empty buckets array for no rows (valid heartbeat)', () => {
    const batch = build([]);
    expect(batch.buckets).toEqual([]);
    expect(batch.schemaVersion).toBe('1.0');
  });
});
