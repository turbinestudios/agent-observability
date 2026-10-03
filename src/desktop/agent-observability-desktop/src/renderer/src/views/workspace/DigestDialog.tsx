import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { OverviewWindow, RepositoryDigestInput } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { renderDigest } from './digest';

/**
 * "What the agents learned here", built entirely on this machine from the
 * index and rendered as Markdown the user can paste into a retro, a wiki, or
 * an agent prompt. No vendor is called: the digest is the same static
 * composition as the 1.15.0 "Improve context files" prompt, over a whole
 * repository instead of one session.
 */
interface Props {
  repository: string;
  window: OverviewWindow;
  onClose: () => void;
  /** Test seam: the digest input, so the component renders without a datahost. */
  input?: RepositoryDigestInput;
}

export function DigestDialog({ repository, window: chosen, onClose, input }: Props): JSX.Element {
  const [markdown, setMarkdown] = useState<string | undefined>(input === undefined ? undefined : renderDigest(input));
  const [error, setError] = useState<string | undefined>(undefined);
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (input !== undefined) {
      return;
    }
    let cancelled = false;
    dataHost
      .call('workspace.repoDigest', repository, { window: chosen })
      .then((next) => {
        if (!cancelled) {
          setMarkdown(renderDigest(next));
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
  }, [repository, chosen, input]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    if (copy !== 'copied') {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopy('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copy]);

  const onCopy = (): void => {
    if (markdown === undefined) {
      return;
    }
    navigator.clipboard
      .writeText(markdown)
      .then(() => setCopy('copied'))
      .catch(() => {
        textRef.current?.select();
        setCopy('failed');
      });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal digest-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="digest-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="digest-title">What the agents learned here</h2>
        <p className="modal-subject">{repository}</p>
        <p className="digest-intro">
          Built from this computer&apos;s index: how sessions went, the friction that recurs, the advice that fires
          most, the context files agents use, models and spend. No session text, paths or branch names are included.
        </p>
        {markdown === undefined && error === undefined && (
          <div className="detail-loading" role="status" aria-live="polite">
            <Spinner size={28} stroke={3} />
          </div>
        )}
        {error !== undefined && (
          <p className="modal-error" role="alert">
            {error}
          </p>
        )}
        {markdown !== undefined && (
          <textarea
            ref={textRef}
            className="digest-text"
            readOnly
            value={markdown}
            spellCheck={false}
            aria-label="Digest as Markdown"
          />
        )}
        {copy === 'failed' && (
          <p className="modal-error" role="alert">
            Could not reach the clipboard. The text is selected, so press Ctrl+C (⌘C on a Mac).
          </p>
        )}
        <div className="modal-actions">
          <span className="improve-prompt-note">Nothing is sent anywhere.</span>
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="modal-btn primary" onClick={onCopy} disabled={markdown === undefined}>
            {copy === 'copied' ? 'Copied' : 'Copy as Markdown'}
          </button>
        </div>
      </div>
    </div>
  );
}
