import { describe, it, expect } from 'vitest';
import { computeSessionComparison, ComparisonInput, MetricId } from './sessionComparison';
import { SessionDetail, SessionTreeStats } from './models';

/**
 * Numeric tests for the comparison-table computation: baseline semantics,
 * delta/percentage rules, better/worse direction, and cost-basis honesty. No
 * HTML here — the renderer's markup is covered in
 * ../views/combinedSessionDetailHtml.test.ts.
 */

function detail(
  over: Partial<SessionDetail['summary']> = {},
  tree: Partial<SessionTreeStats> = {},
): SessionDetail {
  return {
    summary: {
      sessionId: 'sess',
      repository: 'https://github.com/org/repo',
      startedAtMs: 1_000,
      endedAtMs: 2_000,
      durationMs: 1_000,
      interactionCount: 0,
      llmCalls: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      model: 'gpt-test',
      agentModes: ['agent'],
      ...over,
    },
    treeStats: {
      modelTurns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      errorCount: 0,
      aiuNano: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
      ...tree,
    },
    turns: [],
    modelUsage: [],
    agentUsage: [],
    treeModelTurns: [],
  };
}

function row(result: ReturnType<typeof computeSessionComparison>, id: MetricId) {
  const found = result.rows.find((r) => r.id === id);
  if (found === undefined) {
    throw new Error(`no row ${id}`);
  }
  return found;
}

describe('computeSessionComparison', () => {
  it('treats the first session as the baseline: no deltas in its column', () => {
    const result = computeSessionComparison(
      [
        { detail: detail({ sessionId: 'a-1', startedAtMs: 1_000 }, { inputTokens: 100 }) },
        { detail: detail({ sessionId: 'b-2', startedAtMs: 5_000 }, { inputTokens: 50 }) },
      ],
      'aiu',
    );

    expect(result.columns.map((c) => c.sessionId)).toEqual(['a-1', 'b-2']);
    expect(result.columns[0].isBaseline).toBe(true);
    expect(result.columns[1].isBaseline).toBe(false);
    for (const r of result.rows) {
      expect(r.cells[0].delta).toBeUndefined();
    }
  });

  it('computes absolute and percentage change against the baseline, with direction', () => {
    const result = computeSessionComparison(
      [
        { detail: detail({}, { inputTokens: 100, outputTokens: 40 }) },
        { detail: detail({}, { inputTokens: 50, outputTokens: 44 }) },
      ],
      'aiu',
    );

    // Fewer input tokens than the baseline reads as an improvement…
    const input = row(result, 'inputTokens').cells[1].delta;
    expect(input).toMatchObject({ abs: -50, pct: -50, sentiment: 'better' });
    // …and more output tokens as a regression.
    const output = row(result, 'outputTokens').cells[1].delta;
    expect(output).toMatchObject({ abs: 4, pct: 10, sentiment: 'worse' });
  });

  it('marks an unchanged value as `same`', () => {
    const result = computeSessionComparison(
      [{ detail: detail({}, { toolCalls: 8 }) }, { detail: detail({}, { toolCalls: 8 }) }],
      'aiu',
    );
    expect(row(result, 'toolCalls').cells[1].delta).toMatchObject({ abs: 0, sentiment: 'same' });
  });

  it('omits the percentage when the baseline is 0 — errors 0 → 2 is "+2", not "+∞%"', () => {
    const result = computeSessionComparison(
      [{ detail: detail({}, { errorCount: 0 }) }, { detail: detail({}, { errorCount: 2 }) }],
      'aiu',
    );
    const delta = row(result, 'errors').cells[1].delta;
    expect(delta?.abs).toBe(2);
    expect(delta?.pct).toBeUndefined();
    expect(delta?.sentiment).toBe('worse');
  });

  it('keeps line-count rows neutral: writing more code is not better or worse', () => {
    const result = computeSessionComparison(
      [
        { detail: detail({}, { linesOfCode: 100, linesOfDocRemoved: 5 }) },
        { detail: detail({}, { linesOfCode: 220, linesOfDocRemoved: 0 }) },
      ],
      'aiu',
    );
    expect(row(result, 'loc').cells[1].delta?.sentiment).toBe('neutral');
    expect(row(result, 'nlod').cells[1].delta?.sentiment).toBe('neutral');
  });

  it('reads duration from the session summary and LLM calls from the main thread', () => {
    const result = computeSessionComparison(
      [
        { detail: detail({ durationMs: 60_000, llmCalls: 4 }) },
        { detail: detail({ durationMs: 30_000, llmCalls: 6 }) },
      ],
      'aiu',
    );
    expect(row(result, 'duration').cells.map((c) => c.value)).toEqual([60_000, 30_000]);
    expect(row(result, 'duration').cells[1].delta?.sentiment).toBe('better');
    expect(row(result, 'llmCalls').cells.map((c) => c.value)).toEqual([4, 6]);
  });

  it('reads the cost row from the field the chosen basis bills in', () => {
    const sessions: ComparisonInput[] = [
      {
        detail: detail(
          {},
          { aiuNano: 2_000_000_000, costUsdMicros: 1_500_000, creditsNano: 5_000_000_000, creditUnit: 'pru' },
        ),
      },
      { detail: detail({}, { aiuNano: 1_000_000_000, costUsdMicros: 500_000, creditsNano: 3_000_000_000 }) },
    ];

    expect(row(computeSessionComparison(sessions, 'aiu'), 'cost').cells.map((c) => c.value)).toEqual([
      2_000_000_000, 1_000_000_000,
    ]);
    expect(row(computeSessionComparison(sessions, 'usd'), 'cost').cells.map((c) => c.value)).toEqual([
      1_500_000, 500_000,
    ]);
    const credits = computeSessionComparison(sessions, 'credits');
    expect(row(credits, 'cost').cells.map((c) => c.value)).toEqual([5_000_000_000, 3_000_000_000]);
    // The first reported credit unit labels the cost row.
    expect(credits.creditUnit).toBe('pru');
  });

  it('excludes an off-basis session from the cost row instead of showing a false 0', () => {
    const result = computeSessionComparison(
      [
        { detail: detail({}, { costUsdMicros: 1_000_000 }), costMode: 'usd' },
        { detail: detail({}, { aiuNano: 4_000_000_000 }), costMode: 'aiu' },
      ],
      'usd',
    );

    expect(result.columns[1].costExcluded).toBe(true);
    const cost = row(result, 'cost');
    expect(cost.cells[1].value).toBeUndefined();
    expect(cost.cells[1].delta).toBeUndefined();
    // Every other row still compares normally.
    expect(row(result, 'inputTokens').cells[1].value).toBeDefined();
  });

  it('computes no cost deltas at all when the BASELINE is off-basis', () => {
    const result = computeSessionComparison(
      [
        { detail: detail({}, { aiuNano: 4_000_000_000 }), costMode: 'aiu' },
        { detail: detail({}, { costUsdMicros: 1_000_000 }), costMode: 'usd' },
        { detail: detail({}, { costUsdMicros: 2_000_000 }), costMode: 'usd' },
      ],
      'usd',
    );

    expect(result.columns[0].costExcluded).toBe(true);
    const cost = row(result, 'cost');
    expect(cost.cells[0].value).toBeUndefined();
    // On-basis values still show — there is just nothing to measure them against.
    expect(cost.cells[1].value).toBe(1_000_000);
    expect(cost.cells[2].value).toBe(2_000_000);
    expect(cost.cells[1].delta).toBeUndefined();
    expect(cost.cells[2].delta).toBeUndefined();
  });

  it('measures every non-baseline column against column 0, not its neighbour', () => {
    const result = computeSessionComparison(
      [
        { detail: detail({}, { inputTokens: 100 }) },
        { detail: detail({}, { inputTokens: 50 }) },
        { detail: detail({}, { inputTokens: 200 }) },
      ],
      'aiu',
    );

    const cells = row(result, 'inputTokens').cells;
    expect(cells[1].delta).toMatchObject({ abs: -50, pct: -50, sentiment: 'better' });
    // vs. the baseline's 100, not the middle column's 50.
    expect(cells[2].delta).toMatchObject({ abs: 100, pct: 100, sentiment: 'worse' });
  });
});
