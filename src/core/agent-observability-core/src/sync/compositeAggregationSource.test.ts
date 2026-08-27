import { describe, it, expect } from 'vitest';
import { CompositeAggregationSource } from './compositeAggregationSource';
import { AggregationRow } from '../aggregate/aggregator';
import { SessionDataSource } from '../sources/sessionSource';

function row(model: string, ms: number): AggregationRow {
  return {
    startTimeMs: ms,
    sessionKey: 's',
    repository: 'unknown',
    model,
    agentMode: 'agent',
    operation: 'chat',
    durationMs: 0,
    statusCode: 1,
    inputTokens: 1,
    outputTokens: 1,
    cachedTokens: 0,
  };
}

/** Minimal source exposing only getAggregationRows (the rest is unused here). */
function source(
  result: { ok: true; value: AggregationRow[] } | { ok: false; reason: string; message: string },
): SessionDataSource {
  return { getAggregationRows: () => result } as unknown as SessionDataSource;
}

describe('CompositeAggregationSource', () => {
  it('concatenates rows from every ok source', () => {
    const composite = new CompositeAggregationSource(() => [
      source({ ok: true, value: [row('gpt-4o', 1)] }),
      source({ ok: true, value: [row('claude-opus-4-7', 2)] }),
    ]);
    const result = composite.getAggregationRows();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.map((r) => r.model)).toEqual(['gpt-4o', 'claude-opus-4-7']);
    }
  });

  it('still returns the ok source when another fails', () => {
    const composite = new CompositeAggregationSource(() => [
      source({ ok: false, reason: 'error', message: 'claude read failed' }),
      source({ ok: true, value: [row('gpt-4o', 1)] }),
    ]);
    const result = composite.getAggregationRows();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
    }
  });

  it('surfaces a failure only when every source fails', () => {
    const composite = new CompositeAggregationSource(() => [
      source({ ok: false, reason: 'disabled', message: 'off' }),
      source({ ok: false, reason: 'error', message: 'boom' }),
    ]);
    const result = composite.getAggregationRows();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('disabled');
    }
  });

  it('is ok+empty when there are no sources', () => {
    const composite = new CompositeAggregationSource(() => []);
    const result = composite.getAggregationRows();
    expect(result).toEqual({ ok: true, value: [] });
  });
});
