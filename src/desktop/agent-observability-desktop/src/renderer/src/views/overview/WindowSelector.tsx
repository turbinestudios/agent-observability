import type { JSX } from 'react';
import type { OverviewWindow } from '../../../../shared/rpc';
import { OVERVIEW_WINDOWS } from '../../../../shared/rpc';
import { windowLabel } from './window';

/**
 * How far back a page looks.
 *
 * A segmented control rather than a dropdown: there are four choices, they are
 * ordered, and which one is active has to be readable at a glance from anywhere
 * on the page — every number below it depends on the answer. Shared by the
 * Dashboard and the Workspace so the two never label a window differently.
 */
export function WindowSelector({
  value,
  onChange,
}: {
  value: OverviewWindow;
  onChange: (next: OverviewWindow) => void;
}): JSX.Element {
  return (
    <div className="window-selector" role="group" aria-label="Time window">
      {OVERVIEW_WINDOWS.map((option) => (
        <button
          key={String(option)}
          type="button"
          className="window-option"
          aria-pressed={option === value}
          onClick={() => onChange(option)}
        >
          {windowLabel(option)}
        </button>
      ))}
    </div>
  );
}
