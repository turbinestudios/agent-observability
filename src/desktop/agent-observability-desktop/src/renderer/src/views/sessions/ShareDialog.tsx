import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { SessionRow, SharePreview } from '../../../../shared/rpc';
import { Spinner } from '../../components/Spinner';
import { SHARE_CONTAINS, SHARE_LEAVES_OUT, formatBytes, shareRedactionNote } from './share';

/**
 * Shares one session as a file a colleague can import.
 *
 * This is the one place the app writes a session's conversation to a file
 * meant for someone else, so the dialog says plainly what the file holds
 * BEFORE the save dialog opens: the full conversation, with best-effort
 * secret redaction. Nothing is written until the user picks a location, and
 * the app never sends the file anywhere; the user does.
 *
 * Follows the DeleteDialog conventions: Escape, the backdrop, and the
 * initially focused control all cancel.
 */

interface Props {
  row: SessionRow;
  onClose: () => void;
}

type Saved = { path: string; bytes: number };

export function ShareDialog({ row, onClose }: Props): JSX.Element {
  const [preview, setPreview] = useState<SharePreview | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saved, setSaved] = useState<Saved | undefined>(undefined);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('share.preview', row.source, row.sessionId)
      .then((result) => {
        if (!cancelled) {
          setPreview(result);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [row.source, row.sessionId]);

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

  const save = (): void => {
    const suggested = preview?.ok === true ? (preview.title ?? row.title ?? 'session') : 'session';
    setBusy(true);
    setError(undefined);
    void window.desktop
      .pickShareSave(suggested)
      .then(async (filePath) => {
        if (filePath === undefined) {
          return;
        }
        const result = await dataHost.call('share.export', row.source, row.sessionId, filePath);
        if (result.ok) {
          setSaved({ path: result.path, bytes: result.bytes });
        } else {
          setError(result.message);
        }
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const title = row.title ?? row.sessionId;

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal share-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="share-title">{saved === undefined ? 'Share this session as a file?' : 'Session saved'}</h2>
        <p className="modal-subject" title={title}>
          {title}
        </p>

        {saved !== undefined ? (
          <>
            <p>
              Saved {formatBytes(saved.bytes)} to <code className="modal-target">{saved.path}</code>
            </p>
            <p>
              Send the file any way you like. Your colleague opens Sessions, presses{' '}
              <strong>Import</strong> (or drops the file on the list), and can then compare it with
              their own sessions.
            </p>
          </>
        ) : (
          <>
            <p>
              The file holds the <strong>full conversation</strong>. Anyone you give it to can read:
            </p>
            <ul className="share-list">
              {SHARE_CONTAINS.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p>It leaves out:</p>
            <ul className="share-list">
              {SHARE_LEAVES_OUT.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>

            {preview === undefined && error === undefined && (
              <div className="modal-loading">
                <Spinner size={18} stroke={2} />
                <span>Preparing the file…</span>
              </div>
            )}
            {preview?.ok === true && (
              <p className="share-facts">
                {preview.turns} {preview.turns === 1 ? 'turn' : 'turns'}, about {formatBytes(preview.bytes)}.{' '}
                {shareRedactionNote(preview.redactions)}
              </p>
            )}
            {preview?.ok === false && <p className="modal-error">{preview.message}</p>}
            <p className="share-facts">The app writes the file only where you save it, and never sends it anywhere.</p>
          </>
        )}

        {error !== undefined && <p className="modal-error">{error}</p>}

        <div className="modal-actions">
          {busy && <Spinner size={16} stroke={2} />}
          {saved !== undefined ? (
            <>
              <button type="button" className="modal-btn" onClick={() => void window.desktop.showItem(saved.path)}>
                Show in folder
              </button>
              <button type="button" className="modal-btn" ref={cancelRef} onClick={onClose}>
                Done
              </button>
            </>
          ) : (
            <>
              <button type="button" className="modal-btn" ref={cancelRef} onClick={onClose} disabled={busy}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn"
                onClick={save}
                disabled={busy || preview?.ok !== true}
              >
                Save to file…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
