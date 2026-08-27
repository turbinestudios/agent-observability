import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { DeletionPlan, SessionRow } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';

/**
 * Confirms removing a session.
 *
 * Two outcomes, deliberately not one button: hiding takes the session out of
 * the list and can be undone, while deleting erases the transcript or telemetry
 * for good. The dialog names the actual file it would remove and states the
 * consequence in the user's terms, because "are you sure?" over an unnamed
 * target is not a decision anyone can make.
 *
 * The destructive action is never the default — Escape, the backdrop, and the
 * initially focused control all lead away from it.
 */

interface Props {
  row: SessionRow;
  onClose: () => void;
  /** Called after the session has gone, so the list can drop it. */
  onRemoved: () => void;
}

export function DeleteDialog({ row, onClose, onRemoved }: Props): JSX.Element {
  const [plan, setPlan] = useState<DeletionPlan | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    dataHost
      .call('sessions.deletionPlan', row.source, row.sessionId)
      .then(setPlan)
      .catch((err: Error) => setError(err.message));
  }, [row.source, row.sessionId]);

  // Focus lands on Cancel, so a stray Enter dismisses rather than deletes.
  useEffect(() => cancelRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const hide = (): void => {
    setBusy(true);
    void dataHost
      .call('sessions.hide', row.source, row.sessionId, true)
      .then(() => {
        onRemoved();
        onClose();
      })
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  const remove = (): void => {
    setBusy(true);
    void dataHost
      .call('sessions.delete', row.source, row.sessionId)
      .then((result) => {
        if (result.ok) {
          onRemoved();
          onClose();
        } else {
          setError(result.detail);
          setBusy(false);
        }
      })
      .catch((err: Error) => {
        setError(err.message);
        setBusy(false);
      });
  };

  const title = row.title ?? row.sessionId;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-title"
        // Clicks inside must not reach the backdrop's dismiss handler.
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="delete-title">Remove this session?</h2>
        <p className="modal-subject" title={title}>
          {title}
        </p>

        {plan === undefined && error === undefined && (
          <div className="modal-loading">
            <Spinner size={18} stroke={2} />
            <span>Checking what this would remove…</span>
          </div>
        )}

        {plan !== undefined && (
          <>
            <div className="modal-choice">
              <div className="modal-choice-text">
                <strong>Hide it</strong>
                <span>
                  Takes it out of your list and keeps it out, across restarts. Nothing on disk is
                  touched, and you can bring it back later.
                </span>
              </div>
              <button type="button" className="modal-btn" onClick={hide} disabled={busy}>
                Hide
              </button>
            </div>

            <div className={`modal-choice${plan.supported ? ' danger' : ' disabled'}`}>
              <div className="modal-choice-text">
                <strong>Delete permanently</strong>
                <span>{plan.consequence}</span>
                {plan.supported && <code className="modal-target">{plan.target}</code>}
                {plan.caveat !== undefined && <span className="modal-caveat">{plan.caveat}</span>}
              </div>
              <button
                type="button"
                className="modal-btn danger"
                onClick={remove}
                disabled={busy || !plan.supported}
              >
                Delete
              </button>
            </div>
          </>
        )}

        {error !== undefined && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          {busy && <Spinner size={16} stroke={2} />}
          <button type="button" className="modal-btn" ref={cancelRef} onClick={onClose} disabled={busy}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
