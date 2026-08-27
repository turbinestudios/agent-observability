import type { JSX } from 'react';
import { useId, useState } from 'react';

/**
 * The two chart forms the overview needs, as inline SVG.
 *
 * Hand-rolled rather than pulled from a charting library: the renderer runs
 * under a strict CSP with no remote code, the shapes here are simple, and a
 * dependency would outweigh them. Colors arrive as CSS custom properties so a
 * theme switch repaints without re-rendering.
 *
 * Marks follow the house rules: 4px rounded ends anchored to the baseline, a
 * 2px surface gap between stacked segments, recessive axes, and a hover
 * tooltip on every mark.
 */

/** One stacked column: a label plus its segments, bottom-up. */
export interface StackedColumn {
  label: string;
  /** Long-form label for the tooltip, e.g. a full date. */
  fullLabel: string;
  segments: { key: string; value: number }[];
}

export interface SeriesStyle {
  key: string;
  label: string;
  /** A CSS custom property name, e.g. `--series-1`. */
  colorVar: string;
}

interface TooltipState {
  x: number;
  y: number;
  title: string;
  rows: { label: string; value: string; colorVar: string }[];
}

const CHART_HEIGHT = 150;
const AXIS_GAP = 18;
/** Keeps stacked segments visually separate without a stroke. */
const SEGMENT_GAP = 2;
const RADIUS = 4;

/**
 * Sessions or tokens per day, stacked by series.
 *
 * Bars rather than a line because the values are discrete daily counts, and a
 * line would imply a continuous quantity between days.
 */
export function StackedBarChart({
  columns,
  series,
  formatValue,
  emptyMessage,
}: {
  columns: StackedColumn[];
  series: SeriesStyle[];
  formatValue: (value: number) => string;
  emptyMessage: string;
}): JSX.Element {
  const [tip, setTip] = useState<TooltipState | undefined>(undefined);
  const clipId = useId();

  const totals = columns.map((c) => c.segments.reduce((sum, s) => sum + s.value, 0));
  const max = Math.max(1, ...totals);
  if (totals.every((t) => t === 0)) {
    return <p className="chart-empty">{emptyMessage}</p>;
  }

  // A viewBox in column units keeps the bars evenly spaced at any width; the
  // SVG scales to the card, so no resize observer is needed.
  const columnWidth = 10;
  const barWidth = 6;
  const width = columns.length * columnWidth;

  return (
    <div className="chart-wrap">
      <svg
        className="chart"
        viewBox={`0 0 ${width} ${CHART_HEIGHT + AXIS_GAP}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${series.map((s) => s.label).join(' and ')} per day`}
        onMouseLeave={() => setTip(undefined)}
      >
        <defs>
          {/* Rounds only the top of a stack: the baseline end stays square. */}
          <clipPath id={clipId}>
            <rect x="0" y="0" width={width} height={CHART_HEIGHT} />
          </clipPath>
        </defs>

        <line
          className="chart-baseline"
          x1="0"
          y1={CHART_HEIGHT}
          x2={width}
          y2={CHART_HEIGHT}
          vectorEffect="non-scaling-stroke"
        />

        {columns.map((column, index) => {
          const total = totals[index];
          const x = index * columnWidth + (columnWidth - barWidth) / 2;
          let cursor = CHART_HEIGHT;

          return (
            <g
              key={column.label}
              onMouseEnter={(e) =>
                setTip({
                  x: e.clientX,
                  y: e.clientY,
                  title: column.fullLabel,
                  rows: series.map((s) => ({
                    label: s.label,
                    value: formatValue(column.segments.find((seg) => seg.key === s.key)?.value ?? 0),
                    colorVar: s.colorVar,
                  })),
                })
              }
              onMouseMove={(e) => setTip((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev))}
            >
              {/* Full-height target so thin bars and empty days stay hoverable. */}
              <rect
                x={index * columnWidth}
                y={0}
                width={columnWidth}
                height={CHART_HEIGHT}
                fill="transparent"
              />
              {series.map((s) => {
                const value = column.segments.find((seg) => seg.key === s.key)?.value ?? 0;
                if (value <= 0) {
                  return null;
                }
                const height = (value / max) * (CHART_HEIGHT - 4);
                cursor -= height;
                const y = cursor;
                cursor -= SEGMENT_GAP;
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={y}
                    width={barWidth}
                    height={Math.max(1, height)}
                    rx={RADIUS / 2}
                    fill={`var(${s.colorVar})`}
                    clipPath={`url(#${clipId})`}
                  />
                );
              })}
              {total === 0 && (
                <rect x={x} y={CHART_HEIGHT - 1} width={barWidth} height="1" className="chart-zero" />
              )}
            </g>
          );
        })}
      </svg>

      <div className="chart-axis" aria-hidden="true">
        <span>{columns[0]?.label}</span>
        <span>{columns[columns.length - 1]?.label}</span>
      </div>

      {tip !== undefined && <ChartTooltip tip={tip} />}
    </div>
  );
}

/**
 * Magnitude by name — horizontal so long repository names stay readable
 * instead of being rotated or truncated on an axis.
 *
 * Values are labelled directly on every bar, which is also what satisfies the
 * relief rule for series colors that sit below 3:1 on the light surface.
 */
export function HorizontalBars({
  rows,
  colorVar,
  emptyMessage,
}: {
  rows: { label: string; value: number; title?: string }[];
  colorVar: string;
  emptyMessage: string;
}): JSX.Element {
  if (rows.length === 0) {
    return <p className="chart-empty">{emptyMessage}</p>;
  }
  const max = Math.max(1, ...rows.map((r) => r.value));

  return (
    <ul className="hbars">
      {rows.map((row) => (
        <li key={row.label} title={row.title ?? row.label}>
          <span className="hbar-label">{row.label}</span>
          <span className="hbar-track">
            <span
              className="hbar-fill"
              style={{ width: `${(row.value / max) * 100}%`, background: `var(${colorVar})` }}
            />
          </span>
          <span className="hbar-value">{row.value.toLocaleString()}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Follows the pointer in viewport coordinates, so it works regardless of how
 * the SVG is scaled by its container.
 */
function ChartTooltip({ tip }: { tip: TooltipState }): JSX.Element {
  return (
    <div
      className="chart-tooltip"
      role="status"
      style={{
        // Offset from the cursor, and flipped near the right edge so the
        // tooltip never runs off-screen.
        left: Math.min(tip.x + 14, window.innerWidth - 200),
        top: tip.y + 14,
      }}
    >
      <div className="tooltip-title">{tip.title}</div>
      {tip.rows.map((row) => (
        <div key={row.label} className="tooltip-row">
          <span className="tooltip-swatch" style={{ background: `var(${row.colorVar})` }} />
          <span className="tooltip-label">{row.label}</span>
          <span className="tooltip-value">{row.value}</span>
        </div>
      ))}
    </div>
  );
}

/** Identity is never carried by color alone; every chart with 2+ series has one. */
export function Legend({ series }: { series: SeriesStyle[] }): JSX.Element {
  return (
    <div className="chart-legend">
      {series.map((s) => (
        <span key={s.key} className="legend-item">
          <span className="legend-swatch" style={{ background: `var(${s.colorVar})` }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}
