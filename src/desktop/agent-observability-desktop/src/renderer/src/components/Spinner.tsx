import type { JSX } from 'react';

/**
 * Indeterminate progress.
 *
 * An arc over a faint track, rotated by CSS so it costs nothing to leave
 * running — which matters, because the first Copilot session can spend a long
 * time here. Geometry is expressed in a fixed viewBox and scaled by `size`, so
 * the stroke stays visually proportional at any size rather than turning into a
 * thick ring when it grows.
 */

interface Props {
  /** Rendered edge length in px. */
  size?: number;
  /** Stroke weight in px, at the rendered size. */
  stroke?: number;
  className?: string;
}

const VIEWBOX = 50;
const RADIUS = 20;

export function Spinner({ size = 16, stroke = 2, className }: Props): JSX.Element {
  // Convert the px stroke into viewBox units so scaling stays proportional.
  const strokeWidth = (stroke / size) * VIEWBOX;
  const center = VIEWBOX / 2;

  return (
    <svg
      className={className === undefined ? 'spinner' : `spinner ${className}`}
      width={size}
      height={size}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      role="img"
      aria-label="Loading"
    >
      <circle
        cx={center}
        cy={center}
        r={RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        opacity="0.18"
      />
      {/* A quarter arc, which reads as motion more clearly than a longer one. */}
      <path
        d={`M ${center} ${center - RADIUS} A ${RADIUS} ${RADIUS} 0 0 1 ${center + RADIUS} ${center}`}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}
