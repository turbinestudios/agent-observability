import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import type { TeamPreview } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { shortRepo } from '../sessions/format';
import { groupThousands } from './team';

/**
 * The exact file sharing would write, byte for byte. Allowed whether or not
 * sharing is on — previewing is not sharing, exactly as the extension's
 * "Preview Aggregate Payload" command works.
 */
export function TeamPreviewDialog({ onClose }: { onClose: () => void }): JSX.Element {
  const [preview, setPreview] = useState<TeamPreview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('team.preview')
      .then((next) => {
        if (!cancelled) {
          setPreview(next);
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
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal team-preview"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-preview-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="team-preview-title">What will be shared</h2>
        <p className="team-dialog-intro">
          This is the exact file sharing writes to the team folder. Counts and totals under your anonymous id:
          never prompts, responses, names or session titles. The only paths are the repo-relative names of
          context files such as AGENTS.md.
        </p>
        {preview === undefined && error === undefined && (
          <div className="detail-loading" role="status" aria-live="polite">
            <Spinner size={28} stroke={3} />
          </div>
        )}
        {error !== undefined && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}
        {preview !== undefined && (
          <>
            <p className="team-preview-summary">
              {groupThousands(preview.bytes)} bytes · {preview.bucketCount} aggregate buckets ·{' '}
              {preview.contextRowCount} context-file rows · {preview.outcomeRowCount} outcome rows ·{' '}
              {preview.repositories.length === 1 ? '1 repository' : `${preview.repositories.length} repositories`}
              {preview.repositories.length > 0 && ` (${preview.repositories.map(shortRepo).join(', ')})`}
            </p>
            <textarea
              className="team-preview-text"
              readOnly
              value={preview.json}
              spellCheck={false}
              aria-label="Team file as JSON"
            />
          </>
        )}
        <div className="modal-actions">
          <span className="improve-prompt-note">
            {preview?.shareEnabled === true ? 'Sharing is on.' : 'Sharing is off; nothing has been written.'}
          </span>
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
