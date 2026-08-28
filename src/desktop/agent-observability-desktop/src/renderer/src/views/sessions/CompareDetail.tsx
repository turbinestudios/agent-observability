import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { dataHost } from '../../api/client';
import type { SessionRef } from '../../../../shared/rpc';
import { useThemeValue } from '../../theme/ThemeContext';
import { Spinner } from '../../components/Spinner';

/**
 * Several sessions as one document, in the same sandboxed frame the single
 * session uses.
 *
 * The document itself is built by the data host from the shared renderer, so
 * everything specific to a comparison — merged totals, the labelled token
 * trend, a section per session — comes from the same code the extension shows.
 * What this component adds is the frame around it: what the merge had to leave
 * out, and the way back.
 */

interface Props {
  /** Sessions to combine, in selection order; the view sorts them by start time. */
  refs: readonly SessionRef[];
  onClose: () => void;
}

export function CompareDetail({ refs, onClose }: Props): JSX.Element {
  const { theme } = useThemeValue();
  const [docUrl, setDocUrl] = useState<string | undefined>(undefined);
  const [costNote, setCostNote] = useState<string | undefined>(undefined);
  const [skipped, setSkipped] = useState(0);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);

  // The selection is the identity of this view, so a stable string of it is
  // what the effect watches — a fresh array on every render would refetch.
  const key = refs.map((r) => `${r.source}:${r.sessionId}`).join('|');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    dataHost
      .call('sessions.combinedDetail', [...refs], theme)
      .then(async (result) => {
        const url = await window.desktop.stashDetail(result.html);
        if (cancelled) {
          return;
        }
        if (url === undefined) {
          setError('The combined view could not be prepared.');
        } else {
          setDocUrl(url);
          setCostNote(result.costNote);
          setSkipped(result.skipped);
        }
        setLoading(false);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // Watched through `key`, not `refs`: the array is rebuilt on every parent
    // render, and depending on it directly would refetch each time. `key`
    // changes exactly when the selection's contents do.
  }, [key, theme]);

  // Escape is the way out, except while a name is being edited — that Escape
  // belongs to the rename box, which is still on screen behind this view.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') {
        return;
      }
      const active = document.activeElement;
      if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
        return;
      }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  if (error !== undefined) {
    return (
      <div className="placeholder">
        <div>
          <h2>Could not compare these sessions</h2>
          <p>{error}</p>
          <button type="button" className="compare-go" onClick={onClose}>
            Back to sessions
          </button>
        </div>
      </div>
    );
  }

  // A labelled way out, in a toolbar of its own rather than floating over the
  // document — an unlabelled × in the same corner as the single-session Refresh
  // button read as a different action than it was. Escape still works too.
  const toolbar = (
    <div className="compare-toolbar">
      <span className="compare-title">Comparing {refs.length} sessions</span>
      <button type="button" className="compare-go" title="Close comparison (Esc)" onClick={onClose}>
        Close comparison
      </button>
    </div>
  );

  if (loading || docUrl === undefined) {
    // The toolbar is already here while the sessions parse, so the exit is
    // visible during the one stretch where a user most wants it.
    return (
      <div className="compare-layout">
        {toolbar}
        <div className="detail-loading" role="status" aria-live="polite">
          <Spinner size={44} stroke={3} />
          <p className="detail-loading-title">Reading {refs.length} sessions…</p>
          <p className="detail-loading-note">
            Each one is read in full, so this takes longer than opening a single session.
          </p>
        </div>
      </div>
    );
  }

  // The pane lays its children out in a row; the notes belong above the frame.
  return (
    <div className="compare-layout">
      {toolbar}
      {(costNote !== undefined || skipped > 0) && (
        <div className="compare-notes">
          {costNote !== undefined && <p>{costNote}</p>}
          {skipped > 0 && (
            <p>
              {skipped} of the selected sessions could not be read and{' '}
              {skipped === 1 ? 'is' : 'are'} not included.
            </p>
          )}
        </div>
      )}
      <iframe
        className="detail-frame"
        title={`${refs.length} sessions combined`}
        // Same sandbox as a single session: scripts, but no same-origin, so
        // the document cannot reach this app's DOM or the preload bridge.
        sandbox="allow-scripts"
        src={docUrl}
      />
    </div>
  );
}
