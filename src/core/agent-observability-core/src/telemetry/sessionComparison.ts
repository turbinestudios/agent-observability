import type { CloudCreditUnit, CostMode, SessionDetail } from './models';

/**
 * Pure diff computation for the combined-sessions view: per-session metric
 * columns with deltas against a baseline, so a comparison answers "what changed
 * between these runs" instead of only summing them.
 *
 * Presentation-free by design — numeric values, no strings, no HTML — so the
 * delta semantics (what counts as better, when a percentage is meaningful, when
 * a cost is not comparable) are unit-tested without a renderer. The renderer
 * ({@link ../views/sessionDetailHtml.renderComparisonTable}) owns labels and
 * formatting.
 */

/**
 * One session as the comparison sees it. `costMode` is the session's OWN billing
 * basis; absent means "same as the chosen basis" (the extension's uniform-source
 * case, where every section shares the render's basis).
 */
export interface ComparisonInput {
  detail: SessionDetail;
  costMode?: CostMode;
}

/**
 * Whether a decrease in the metric reads as an improvement. Line counts are
 * `neutral`: writing more (or less) code is information, not a verdict.
 */
export type MetricDirection = 'lower-better' | 'neutral';

/** Stable row identity; the renderer keys labels and tooltips off this. */
export type MetricId =
  | 'duration'
  | 'modelTurns'
  | 'toolCalls'
  | 'llmCalls'
  | 'inputTokens'
  | 'outputTokens'
  | 'cachedTokens'
  | 'totalTokens'
  | 'errors'
  | 'cost'
  | 'loc'
  | 'lod'
  | 'nloc'
  | 'nlod';

/** How the renderer should format the row's values (and absolute deltas). */
export type MetricFormat = 'duration' | 'integer' | 'cost';

/** A non-baseline cell's change against the baseline column. */
export interface ComparisonDelta {
  /** value − baseline value. */
  abs: number;
  /**
   * Percentage change against the baseline, absent when the baseline value is 0
   * — a percentage of nothing is meaningless (errors going 0 → 2 is "+2", not
   * "+∞%").
   */
  pct?: number;
  /**
   * How the change reads: `better`/`worse` per the row's direction, `same` for
   * no change, `neutral` for rows where change carries no verdict (line counts).
   */
  sentiment: 'better' | 'worse' | 'same' | 'neutral';
}

/** One cell of the table: a session's value for a metric, plus its delta. */
export interface ComparisonCell {
  /**
   * Absent when the value is not comparable (the cost of a session billed on a
   * different basis) — the renderer shows an em dash, never a fabricated 0.
   */
  value?: number;
  /** Absent on the baseline column and whenever either side has no value. */
  delta?: ComparisonDelta;
}

/** One metric row across every column, in {@link SessionComparison.columns} order. */
export interface ComparisonRow {
  id: MetricId;
  direction: MetricDirection;
  format: MetricFormat;
  cells: ComparisonCell[];
}

/** One session column, in the caller's (start-time) order. */
export interface ComparisonColumn {
  /** Full session id; the renderer shortens and escapes it. */
  sessionId: string;
  title?: string;
  startedAtMs: number;
  /** True for index 0 only — the column every delta is measured against. */
  isBaseline: boolean;
  /** True when this session bills on a different basis than the chosen one. */
  costExcluded: boolean;
}

export interface SessionComparison {
  columns: ComparisonColumn[];
  rows: ComparisonRow[];
  /** The basis the cost row is denominated in (the render's chosen basis). */
  costMode: CostMode;
  /** First reported credit unit, for the cost row's label when `credits`. */
  creditUnit?: CloudCreditUnit;
}

/** Whole-tree metric values for one session, in row order. */
interface MetricSpec {
  id: MetricId;
  direction: MetricDirection;
  format: MetricFormat;
  /** Absent for `cost`, whose value depends on the chosen basis. */
  value?: (input: ComparisonInput) => number;
}

const METRICS: readonly MetricSpec[] = [
  { id: 'duration', direction: 'lower-better', format: 'duration', value: (s) => s.detail.summary.durationMs },
  { id: 'modelTurns', direction: 'lower-better', format: 'integer', value: (s) => s.detail.treeStats.modelTurns },
  { id: 'toolCalls', direction: 'lower-better', format: 'integer', value: (s) => s.detail.treeStats.toolCalls },
  // Main-thread scope (unlike the tree-scoped rows) — the renderer labels it so.
  { id: 'llmCalls', direction: 'lower-better', format: 'integer', value: (s) => s.detail.summary.llmCalls },
  { id: 'inputTokens', direction: 'lower-better', format: 'integer', value: (s) => s.detail.treeStats.inputTokens },
  { id: 'outputTokens', direction: 'lower-better', format: 'integer', value: (s) => s.detail.treeStats.outputTokens },
  { id: 'cachedTokens', direction: 'lower-better', format: 'integer', value: (s) => s.detail.treeStats.cachedTokens },
  { id: 'totalTokens', direction: 'lower-better', format: 'integer', value: (s) => s.detail.treeStats.totalTokens },
  { id: 'errors', direction: 'lower-better', format: 'integer', value: (s) => s.detail.treeStats.errorCount },
  { id: 'cost', direction: 'lower-better', format: 'cost' },
  { id: 'loc', direction: 'neutral', format: 'integer', value: (s) => s.detail.treeStats.linesOfCode },
  { id: 'lod', direction: 'neutral', format: 'integer', value: (s) => s.detail.treeStats.linesOfDoc },
  { id: 'nloc', direction: 'neutral', format: 'integer', value: (s) => s.detail.treeStats.linesOfCodeRemoved },
  { id: 'nlod', direction: 'neutral', format: 'integer', value: (s) => s.detail.treeStats.linesOfDocRemoved },
];

/** The session's cost on the CHOSEN basis, read from its whole-tree stats. */
function costValue(input: ComparisonInput, costMode: CostMode): number {
  const t = input.detail.treeStats;
  if (costMode === 'usd') {
    return t.costUsdMicros ?? 0;
  }
  if (costMode === 'credits') {
    return t.creditsNano ?? 0;
  }
  return t.aiuNano;
}

/**
 * Compute the comparison table for two or more sessions.
 *
 * CONTRACT: the caller passes sessions already sorted by start time (both hosts
 * sort sections by `startedAtMs` before rendering); **index 0 is the baseline**
 * and this function does not re-sort. Every non-baseline cell's delta is
 * measured against the baseline's value for that row.
 *
 * Cost honesty: a session whose own `costMode` differs from the chosen basis is
 * marked `costExcluded` and its cost cell carries no value — an off-basis cost
 * shown as 0 would read as "free". When the BASELINE itself is off-basis there
 * is nothing to measure against, so no cost deltas are computed at all (values
 * still show).
 */
export function computeSessionComparison(
  sessions: readonly ComparisonInput[],
  costMode: CostMode,
): SessionComparison {
  const columns: ComparisonColumn[] = sessions.map((s, index) => ({
    sessionId: s.detail.summary.sessionId,
    ...(s.detail.summary.title !== undefined ? { title: s.detail.summary.title } : {}),
    startedAtMs: s.detail.summary.startedAtMs,
    isBaseline: index === 0,
    costExcluded: s.costMode !== undefined && s.costMode !== costMode,
  }));
  const baselineCostExcluded = columns[0]?.costExcluded === true;

  const rows: ComparisonRow[] = METRICS.map((metric) => {
    const values = sessions.map((s, index) => {
      if (metric.value !== undefined) {
        return metric.value(s);
      }
      return columns[index].costExcluded ? undefined : costValue(s, costMode);
    });
    const baseline = values[0];

    const cells: ComparisonCell[] = values.map((value, index) => {
      if (value === undefined) {
        return {};
      }
      if (index === 0 || baseline === undefined || (metric.id === 'cost' && baselineCostExcluded)) {
        return { value };
      }
      const abs = value - baseline;
      const sentiment: ComparisonDelta['sentiment'] =
        metric.direction === 'neutral' ? 'neutral' : abs === 0 ? 'same' : abs < 0 ? 'better' : 'worse';
      const delta: ComparisonDelta = { abs, sentiment };
      if (baseline > 0) {
        delta.pct = (abs / baseline) * 100;
      }
      return { value, delta };
    });

    return { id: metric.id, direction: metric.direction, format: metric.format, cells };
  });

  const creditUnit = sessions
    .map((s) => s.detail.treeStats.creditUnit)
    .find((unit) => unit !== undefined);

  return {
    columns,
    rows,
    costMode,
    ...(creditUnit !== undefined ? { creditUnit } : {}),
  };
}
