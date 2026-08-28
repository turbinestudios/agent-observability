import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { formatTransfer } from '../../../shared/updates';
import type { UpdateStatus } from '../../../shared/updates';
import { useUpdateStatus } from '../updates/useUpdateStatus';
import { rotatedNote } from './loadingNotes';
import { useNoteTick } from './useNoteTick';
import { Spinner } from './Spinner';

/**
 * The download dialog behind **Update now**.
 *
 * Consenting to an update hands control to a background download that can run
 * for minutes, and the only feedback used to be a sliver of progress in the
 * 52px sidebar plus the taskbar — subtle enough that "nothing happens" was the
 * honest user experience. This puts the download where the user is looking: a
 * real bar, the percentage, the size and speed, and the same rotating notes
 * every other wait in the app has.
 *
 * Deliberately escapable: **Continue in background** (or Escape, or the
 * backdrop) hides it and the sidebar indicator carries on — a modal that traps
 * the user for a whole download would trade one bad experience for another.
 * When the download completes, main's native "restart now?" prompt takes over,
 * so the `downloaded` phase renders nothing here. A failure shows in place
 * instead, with the message — unless the dialog was already dismissed, in
 * which case the sidebar's Failed marker keeps that quieter role.
 */

/** App-level wrapper: subscribes, and remembers what the user dismissed. */
export function UpdateDownloadOverlay(): JSX.Element | null {
  const status = useUpdateStatus();
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);

  if (status === undefined || status.phase === 'downloaded') {
    return null;
  }
  // A dismissal sticks for this download (or this failure) only: a NEW version
  // starting to download deserves a fresh dialog.
  const key = status.phase === 'downloading' ? `download:${status.version}` : 'failed';
  if (dismissed === key) {
    return null;
  }
  return <UpdateDialogView status={status} onDismiss={() => setDismissed(key)} />;
}

/** The dialog itself, stateless so it renders headless in tests. */
export function UpdateDialogView({
  status,
  onDismiss,
}: {
  status: Exclude<UpdateStatus, { phase: 'downloaded' }>;
  onDismiss: () => void;
}): JSX.Element {
  const dismissRef = useRef<HTMLButtonElement>(null);
  const note = useNoteTick('update-download', status.phase === 'downloading');
  useEffect(() => dismissRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  if (status.phase === 'failed') {
    return (
      <div className="modal-backdrop" onMouseDown={onDismiss}>
        <div
          className="modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="update-dialog-title"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <h2 id="update-dialog-title">The update could not be downloaded</h2>
          <p className="update-error">{status.message}</p>
          <p className="update-note">Nothing changed — you are still on the version you were.</p>
          <div className="modal-actions">
            <button ref={dismissRef} type="button" className="modal-btn" onClick={onDismiss}>
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  const starting = status.transferred === 0 && status.total === 0;
  return (
    <div className="modal-backdrop" onMouseDown={onDismiss}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="update-dialog-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="update-dialog-title">Downloading version {status.version}…</h2>
        <div className="update-progress-row">
          <div
            className="update-progress"
            role="progressbar"
            aria-label={`Downloading version ${status.version}`}
            aria-valuenow={Math.round(status.percent)}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div className="update-progress-fill" style={{ width: `${status.percent}%` }} />
          </div>
          <span className="update-percent">{Math.round(status.percent)}%</span>
        </div>
        <p className="update-transfer">
          {starting ? (
            <>
              <Spinner size={12} stroke={2} /> Contacting GitHub…
            </>
          ) : (
            formatTransfer(status)
          )}
        </p>
        <p className="update-note">
          {rotatedNote(['It installs after a restart — keep working meanwhile.'], note.tick, note.seed)}
        </p>
        <div className="modal-actions">
          <button ref={dismissRef} type="button" className="modal-btn" onClick={onDismiss}>
            Continue in background
          </button>
        </div>
      </div>
    </div>
  );
}
