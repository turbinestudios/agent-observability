import type { JSX } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildImproveContextPrompt,
  defaultPromptScope,
  filesInScope,
  type ContextPromptScope,
} from '@agent-observability/core/src/context/improvePrompt';
import type { ContextPromptFacts } from '../../../../shared/rpc';

interface Props {
  facts: ContextPromptFacts;
  onClose: () => void;
}

/**
 * The "Improve context files" prompt: built here, from facts the data host
 * read out of the same analysis the document shows, and only ever copied to
 * the clipboard. Nothing is sent anywhere — the user pastes it into their own
 * coding agent, which reads the files itself. The full text is shown before
 * it is copied, so the user sees exactly what they are pasting.
 *
 * Follows the DeleteDialog conventions: Escape and the backdrop close it, and
 * the primary action takes focus.
 */
export function ImprovePromptDialog({ facts, onClose }: Props): JSX.Element {
  const [scope, setScope] = useState<ContextPromptScope>(() => defaultPromptScope(facts));
  const [copy, setCopy] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyRef = useRef<HTMLButtonElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const prompt = useMemo(() => buildImproveContextPrompt(facts, scope), [facts, scope]);
  const flagged = filesInScope(facts, 'flagged').length;

  useEffect(() => copyRef.current?.focus(), []);
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
    navigator.clipboard
      .writeText(prompt)
      .then(() => setCopy('copied'))
      .catch(() => {
        // Leave the text selected so a keyboard copy still works.
        textRef.current?.select();
        setCopy('failed');
      });
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal improve-prompt"
        role="dialog"
        aria-modal="true"
        aria-labelledby="improve-prompt-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="improve-prompt-title">Improve context files</h2>
        <p className="modal-subject">{facts.agentName}</p>
        <p className="improve-prompt-intro">
          Paste this prompt into Claude Code or Copilot, opened in this repository. It names the
          files and what this session measured about them, and your agent does the editing.
        </p>
        <div className="improve-prompt-scope" role="radiogroup" aria-label="Files to include">
          <label>
            <input
              type="radio"
              name="improve-scope"
              checked={scope === 'flagged'}
              disabled={flagged === 0}
              onChange={() => setScope('flagged')}
            />
            Files with warnings ({flagged})
          </label>
          <label>
            <input type="radio" name="improve-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
            All loaded files ({facts.files.length})
          </label>
        </div>
        <textarea
          ref={textRef}
          className="improve-prompt-text"
          readOnly
          value={prompt}
          spellCheck={false}
          aria-label="Prompt"
        />
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
          <button ref={copyRef} type="button" className="modal-btn primary" onClick={onCopy}>
            {copy === 'copied' ? 'Copied' : 'Copy prompt'}
          </button>
        </div>
      </div>
    </div>
  );
}
