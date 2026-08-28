import type { JSX } from 'react';
import { describeStatus, formatPercent } from '../../../shared/updates';
import type { UpdateStatus } from '../../../shared/updates';

/**
 * What the sidebar shows while an update is being fetched.
 *
 * Pressing **Update now** hands control to a background download that can take
 * a minute, and the app said nothing about it until the install prompt appeared
 * — long enough to read as a hang. This is the missing feedback: a bar that
 * moves, a percentage, and the detail on hover.
 *
 * It sits above the version rather than replacing it, so the thing the user is
 * upgrading FROM stays on screen throughout, and a failure does not silently
 * cost them the version number.
 */

interface Props {
  status: UpdateStatus;
}

export function UpdateIndicator({ status }: Props): JSX.Element {
  const detail = describeStatus(status);

  if (status.phase === 'downloading') {
    return (
      <div className="rail-update" title={detail}>
        <div
          className="rail-progress"
          role="progressbar"
          aria-label={detail}
          aria-valuenow={Math.round(status.percent)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="rail-progress-fill" style={{ width: `${status.percent}%` }} />
        </div>
        <span className="rail-update-text">{formatPercent(status)}</span>
      </div>
    );
  }

  return (
    <div className="rail-update" title={detail}>
      <span className={`rail-update-text ${status.phase === 'failed' ? 'failed' : 'ready'}`}>
        {status.phase === 'failed' ? 'Failed' : 'Ready'}
      </span>
    </div>
  );
}
