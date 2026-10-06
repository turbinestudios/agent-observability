import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { HandoffBrief, ReviewPacketResult, SessionRef } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import { openRunDoor, useRunEnabled } from '../run/doors';
import {
  REVIEWER_PREFILL,
  canResumeInTerminal,
  charCountLabel,
  packetStats,
  redactionLabel,
  renderHandoff,
  renderPacket,
  totalRedactions,
} from './packet';

/**
 * The two dialogs that turn a session into text the user copies: the review
 * packet (for a human about to read the diff) and the hand-off brief (for the
 * next agent session). Both are built on this machine with no AI, shown in
 * full before anything is copied, and leave the app only through the
 * clipboard on the user's own click.
 */

type CopyState = 'idle' | 'copied' | 'failed';

function useEscape(onClose: () => void): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
}

function useCopy(text: string | undefined): {
  copy: CopyState;
  onCopy: () => Promise<boolean>;
  textRef: React.RefObject<HTMLTextAreaElement | null>;
} {
  const [copy, setCopy] = useState<CopyState>('idle');
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    if (copy !== 'copied') {
      return undefined;
    }
    const timer = window.setTimeout(() => setCopy('idle'), 2000);
    return () => window.clearTimeout(timer);
  }, [copy]);
  const onCopy = async (): Promise<boolean> => {
    if (text === undefined || text.length === 0) {
      return false;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopy('copied');
      return true;
    } catch {
      // Leave the text selected so a keyboard copy still works.
      textRef.current?.select();
      setCopy('failed');
      return false;
    }
  };
  return { copy, onCopy, textRef };
}

interface PacketProps {
  refs: SessionRef[];
  onClose: () => void;
  /** Opens the AI Helper on the session with a fixed question; absent for several sessions. */
  onAskAi?: (source: string, sessionId: string, prefill: string) => void;
}

export function ReviewPacketDialog({ refs, onClose, onAskAi }: PacketProps): JSX.Element {
  const [result, setResult] = useState<ReviewPacketResult | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [includePrompts, setIncludePrompts] = useState(true);
  useEscape(onClose);

  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('settings.get')
      .then((snapshot) => {
        if (!cancelled) {
          setIncludePrompts(snapshot.packetIncludePrompts);
        }
      })
      .catch(() => undefined);
    dataHost
      .call('sessions.reviewPacket', refs)
      .then((next) => {
        if (!cancelled) {
          setResult(next);
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
    // The refs identify the dialog instance; it is remounted for a new selection.
  }, []);

  const markdown = result === undefined ? undefined : renderPacket(result, { includePrompts });
  const { copy, onCopy, textRef } = useCopy(markdown);
  const stats = markdown === undefined ? undefined : packetStats(markdown);
  const redacted = result === undefined ? undefined : redactionLabel(totalRedactions(result));
  const single = refs.length === 1 ? refs[0] : undefined;

  const togglePrompts = (next: boolean): void => {
    setIncludePrompts(next);
    void dataHost.call('settings.update', { packetIncludePrompts: next }).catch(() => undefined);
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal digest-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="packet-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="packet-title">Review packet</h2>
        <p className="digest-intro">
          What was asked, which files changed and how often they were re-edited, the commands that ran and failed,
          dead ends, risky actions, cost and the retrospective&apos;s findings. Built on this computer with no AI, for
          the person about to read the diff. File paths are relative to the repository; no tool output is included.
        </p>
        <label className="settings-toggle">
          <input type="checkbox" checked={includePrompts} onChange={(e) => togglePrompts(e.target.checked)} />
          Include what I asked
        </label>
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
        {result !== undefined && result.skipped.length > 0 && (
          <p className="modal-error" role="alert">
            {result.skipped.length === 1 ? '1 session' : `${result.skipped.length} sessions`} could not be read and{' '}
            {result.skipped.length === 1 ? 'is' : 'are'} not in the packet: {result.skipped[0].message}
          </p>
        )}
        {result?.note !== undefined && <p className="digest-intro">{result.note}</p>}
        {markdown !== undefined && markdown.length > 0 && (
          <textarea
            ref={textRef}
            className="digest-text"
            readOnly
            value={markdown}
            spellCheck={false}
            aria-label="Review packet as Markdown"
          />
        )}
        {stats !== undefined && (
          <p className="digest-intro">
            {charCountLabel(stats.chars)}
            {stats.overPrLimit && ' — longer than a GitHub pull request description allows'}
            {redacted !== undefined && ` · ${redacted} Read it before you share it.`}
          </p>
        )}
        {copy === 'failed' && (
          <p className="modal-error" role="alert">
            Could not reach the clipboard. The text is selected, so press Ctrl+C (⌘C on a Mac).
          </p>
        )}
        <div className="modal-actions">
          <span className="improve-prompt-note">Nothing is sent anywhere.</span>
          {single !== undefined && onAskAi !== undefined && (
            <button
              type="button"
              className="modal-btn"
              title="Opens the AI Helper with a question filled in. Nothing is sent until you press Send."
              onClick={() => onAskAi(single.source, single.sessionId, REVIEWER_PREFILL)}
            >
              Ask AI Helper to summarize for a reviewer
            </button>
          )}
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
          <button
            type="button"
            className="modal-btn primary"
            disabled={markdown === undefined || markdown.length === 0}
            onClick={() => void onCopy()}
          >
            {copy === 'copied' ? 'Copied' : 'Copy as Markdown'}
          </button>
        </div>
      </div>
    </div>
  );
}

interface HandoffProps {
  source: string;
  sessionId: string;
  onClose: () => void;
}

export function HandoffDialog({ source, sessionId, onClose }: HandoffProps): JSX.Element {
  const runEnabled = useRunEnabled();
  const [brief, setBrief] = useState<HandoffBrief | undefined>(undefined);
  const [note, setNote] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [terminal, setTerminal] = useState<{ message: string; command?: string } | undefined>(undefined);
  useEscape(onClose);

  useEffect(() => {
    let cancelled = false;
    dataHost
      .call('sessions.handoffBrief', source, sessionId)
      .then((next) => {
        if (!cancelled) {
          setBrief(next.brief);
          setNote(next.note);
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
  }, [source, sessionId]);

  const markdown = brief === undefined ? undefined : renderHandoff(brief);
  const { copy, onCopy, textRef } = useCopy(markdown);
  const redacted = brief === undefined ? undefined : redactionLabel(brief.redactions);

  const resume = async (): Promise<void> => {
    setTerminal(undefined);
    try {
      const target = await dataHost.call('sessions.handoff', source, sessionId);
      if (target.problem !== undefined || target.cwd === undefined) {
        setTerminal({ message: target.problem ?? 'This session cannot be resumed in a terminal.' });
        return;
      }
      const copied = await onCopy();
      const opened = await window.desktop.openTerminal({
        cwd: target.cwd,
        cli: target.cli,
        sessionId: target.sessionId,
      });
      if (opened.ok) {
        setTerminal({
          message: copied
            ? 'Your terminal is opening on this session. The brief is on your clipboard.'
            : 'Your terminal is opening on this session.',
        });
      } else {
        setTerminal({
          message: 'No terminal could be opened. Run this in the session folder yourself:',
          ...(opened.fallbackCommand !== undefined ? { command: opened.fallbackCommand } : {}),
        });
      }
    } catch (err) {
      setTerminal({ message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div
        className="modal digest-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="handoff-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="handoff-title">Hand off</h2>
        <p className="digest-intro">
          A brief for starting the next session where this one stopped: the goal, where things stand, the constraints
          you stated, the files in play, what was and was not verified, open items, and a first prompt. Built on this
          computer with no AI. Paste it as the first message of a new session.
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
        {note !== undefined && <p className="digest-intro">{note}</p>}
        {markdown !== undefined && (
          <textarea
            ref={textRef}
            className="digest-text"
            readOnly
            value={markdown}
            spellCheck={false}
            aria-label="Hand-off brief as Markdown"
          />
        )}
        {markdown !== undefined && (
          <p className="digest-intro">
            {charCountLabel(markdown.length)}
            {redacted !== undefined && ` · ${redacted} Read it before you share it.`}
          </p>
        )}
        {copy === 'failed' && (
          <p className="modal-error" role="alert">
            Could not reach the clipboard. The text is selected, so press Ctrl+C (⌘C on a Mac).
          </p>
        )}
        {terminal !== undefined && (
          <p className="digest-intro" role="status">
            {terminal.message}
            {terminal.command !== undefined && (
              <>
                {' '}
                <code>{terminal.command}</code>
              </>
            )}
          </p>
        )}
        <div className="modal-actions">
          <span className="improve-prompt-note">Nothing is sent anywhere.</span>
          {canResumeInTerminal(source) && (
            <button
              type="button"
              className="modal-btn"
              disabled={markdown === undefined}
              title="Copies the brief and opens your own terminal in this session's folder, resuming it with your own CLI"
              onClick={() => void resume()}
            >
              Resume in terminal
            </button>
          )}
          {runEnabled && (
            <button
              type="button"
              className="modal-btn"
              title="Opens Run with this brief as an editable goal. Nothing is sent until you press Start."
              onClick={() => {
                openRunDoor({ door: 'handoff-brief', source, sessionId });
                onClose();
              }}
            >
              Start a session from this brief
            </button>
          )}
          <button type="button" className="modal-btn" onClick={onClose}>
            Close
          </button>
          <button type="button" className="modal-btn primary" disabled={markdown === undefined} onClick={() => void onCopy()}>
            {copy === 'copied' ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
    </div>
  );
}
