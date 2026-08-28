import type { JSX } from 'react';
import { compareState } from './selection';

/**
 * The bulk action for a ticked selection, pinned below the list.
 *
 * A footer rather than a strip above the rows: it appears and disappears as
 * sessions are ticked, and anywhere higher would shift the list under the
 * cursor mid-selection.
 */

interface Props {
  /** Ticked session keys, in the order they were ticked. */
  keys: readonly string[];
  onCompare: () => void;
  onClear: () => void;
}

export function CompareBar({ keys, onCompare, onClear }: Props): JSX.Element | null {
  const { count, canCompare, reason } = compareState(keys);
  if (count === 0) {
    return null;
  }

  return (
    <div className="compare-bar">
      <span className="compare-count">
        {count} selected
        {reason !== undefined && <span className="compare-reason">{reason}</span>}
      </span>
      <button
        type="button"
        className="compare-go"
        disabled={!canCompare}
        title={reason ?? `Open ${count} sessions as one view`}
        onClick={onCompare}
      >
        Compare
      </button>
      <button
        type="button"
        className="compare-clear"
        aria-label="Clear selection"
        title="Clear selection"
        onClick={onClear}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.3 5.71 12 12l6.3 6.29-1.41 1.42L10.59 13.4 4.3 19.71 2.89 18.3 9.18 12 2.89 5.71 4.3 4.29l6.29 6.3 6.3-6.3 1.41 1.42Z" />
        </svg>
      </button>
    </div>
  );
}
