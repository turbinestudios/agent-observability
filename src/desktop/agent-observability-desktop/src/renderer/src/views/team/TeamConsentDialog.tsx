import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { teamConsentDetail } from '@agent-observability/core/src/consent/consentDisclosure';
import type { TeamPreview } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { shortRepo } from '../sessions/format';

/**
 * The consent gate for team sharing. Lists every repository the file would
 * cover, all checked; unchecking any produces an exclude list. Confirm is the
 * only path that turns sharing on.
 */
interface Props {
  folder: string;
  onCancel: () => void;
  onConfirm: (mode: 'all' | 'exclude', repositories: string[]) => void;
}

export function TeamConsentDialog({ folder, onCancel, onConfirm }: Props): JSX.Element {
  const [preview, setPreview] = useState<TeamPreview | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

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
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const repositories = preview?.repositories ?? [];
  const included = repositories.filter((r) => !excluded.has(r));
  const toggle = (repository: string): void => {
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(repository)) {
        next.delete(repository);
      } else {
        next.add(repository);
      }
      return next;
    });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal team-consent"
        role="dialog"
        aria-modal="true"
        aria-labelledby="team-consent-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="team-consent-title">Share with the team folder?</h2>
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
            <pre className="team-consent-detail">{teamConsentDetail(folder, included)}</pre>
            {repositories.length > 0 && (
              <fieldset className="team-consent-repos">
                <legend>Repositories to include</legend>
                {repositories.map((repository) => (
                  <label key={repository} className="settings-toggle" title={repository}>
                    <input
                      type="checkbox"
                      checked={!excluded.has(repository)}
                      onChange={() => toggle(repository)}
                    />
                    {shortRepo(repository)}
                  </label>
                ))}
              </fieldset>
            )}
          </>
        )}
        <div className="modal-actions">
          <button type="button" className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="modal-btn primary"
            disabled={preview === undefined}
            onClick={() =>
              excluded.size === 0 ? onConfirm('all', []) : onConfirm('exclude', [...excluded].sort())
            }
          >
            Share with the team folder
          </button>
        </div>
      </div>
    </div>
  );
}
