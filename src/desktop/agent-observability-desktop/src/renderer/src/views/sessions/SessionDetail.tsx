import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { AiAvailability, SessionRow } from '../../../../shared/rpc';
import { useThemeValue } from '../../theme/ThemeContext';
import { Spinner } from '../../components/Spinner';
import { rotatedNote } from '../../components/loadingNotes';
import { useNoteTick } from '../../components/useNoteTick';

/**
 * Renders a session using the shared detail renderer, inside a sandboxed iframe.
 *
 * An iframe rather than inline markup, because that renderer emits a complete
 * document: its own strict CSP, its own stylesheet, and a controller script.
 * Injecting the body into this page would drop the CSP, leak ~600 lines of CSS
 * into the app's styles, and put session content — which can be arbitrary text
 * from a model or a repository — directly in the app's origin. Sandboxed, the
 * document keeps its protections and cannot reach back into the app.
 */

interface Props {
  row: SessionRow;
  /** Attach this session to the AI Helper and switch to it. */
  onAskAi?: (source: string, sessionId: string) => void;
}

/**
 * Whether a Copilot detail has been opened yet this run. The first one is slow
 * for reasons the user should be told about; the rest are not.
 */
let copilotWarmed = false;

/** What the embedded document posts out through the shimmed API. */
interface DetailMessage {
  type?: string;
  path?: string;
  url?: string;
  file?: string;
  source?: string;
}

export function SessionDetail({ row, onAskAi }: Props): JSX.Element {
  const { theme } = useThemeValue();
  const [docUrl, setDocUrl] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // The deep-retrospective consent flow: the document's button only asks; the
  // per-invocation confirmation happens HERE, outside the sandboxed frame, so
  // no document content can fake its way past it.
  const [deepConfirm, setDeepConfirm] = useState(false);
  const [deepRunning, setDeepRunning] = useState(false);
  const [deepError, setDeepError] = useState<string | undefined>(undefined);
  // Probed when the dialog opens — the CLI is the dialog's whole means of
  // action, so a missing install must block the confirm, not fail after it.
  const [deepAvailability, setDeepAvailability] = useState<AiAvailability | undefined>(undefined);
  const frameRef = useRef<HTMLIFrameElement>(null);
  // Bumped by the refresh button; the ref marks the next fetch as forced so
  // only a deliberate refresh re-parses (a theme change reuses the cache).
  const [refreshToken, setRefreshToken] = useState(0);
  const forceRef = useRef(false);
  // The loading note rotates like the startup overlay's: honest lead first,
  // then the shared fun pool in a per-session shuffle. Pauses once loaded.
  const note = useNoteTick(`${row.source}:${row.sessionId}`, loading);

  const checkAvailability = useCallback(() => {
    setDeepAvailability(undefined);
    dataHost
      .call('ai.availability')
      .then(setDeepAvailability)
      .catch((err: Error) => setDeepAvailability({ available: false, reason: err.message }));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    const force = forceRef.current;
    forceRef.current = false;

    dataHost
      .call('sessions.detail', row.source, row.sessionId, theme, force)
      .then(async (doc) => {
        if (row.source === 'copilot') {
          copilotWarmed = true;
        }
        // Loaded from a URL rather than inlined: an inline frame would inherit
        // this page's script policy, which blocks the document's own scripts
        // and leaves it looking fine but completely inert.
        const url = await window.desktop.stashDetail(doc);
        // A slow parse must not overwrite a newer selection.
        if (!cancelled) {
          if (url === undefined) {
            setError('The session view could not be prepared.');
          } else {
            setDocUrl(url);
          }
          setLoading(false);
        }
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
  }, [row.source, row.sessionId, row.indexedAtMs, theme, refreshToken]);

  // The document posts through the shimmed `acquireVsCodeApi`; those messages
  // arrive here wrapped so they are distinguishable from anything else.
  useEffect(() => {
    function onMessage(event: MessageEvent): void {
      if (event.source !== frameRef.current?.contentWindow) {
        return;
      }
      const payload = (event.data as { __aoDetail?: DetailMessage })?.__aoDetail;
      if (payload === undefined) {
        return;
      }
      if (payload.type === 'open-context-file' && typeof payload.path === 'string') {
        void window.desktop.openPath(payload.path);
        return;
      }
      if (payload.type === 'open-external-url' && typeof payload.url === 'string') {
        void window.desktop.openExternal(payload.url);
        return;
      }
      if (payload.type === 'deep-retrospective') {
        setDeepError(undefined);
        setDeepConfirm(true);
        checkAvailability();
        return;
      }
      // Accepting a missing file or source is remembered in settings, and the
      // analysis has to be rebuilt against it. The refreshed body is swapped in
      // place so the open tab, sections, and scroll position all survive.
      const action =
        payload.type === 'accept-missing-file' && typeof payload.file === 'string'
          ? ({ kind: 'accept-file', value: payload.file } as const)
          : payload.type === 'accept-missing-source' && typeof payload.source === 'string'
            ? ({ kind: 'accept-source', value: payload.source } as const)
            : undefined;
      if (action !== undefined) {
        void dataHost
          .call('sessions.contextAction', row.source, row.sessionId, action)
          .then((body) => {
            frameRef.current?.contentWindow?.postMessage({ type: 'update', html: body }, '*');
          })
          .catch(() => undefined);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [row.source, row.sessionId, checkAvailability]);

  if (error !== undefined) {
    return (
      <div className="placeholder">
        <div>
          <h2>Could not open this session</h2>
          <p>{error}</p>
        </div>
      </div>
    );
  }

  if (loading || docUrl === undefined) {
    // The first Copilot session opened in a run pays a large one-time cost:
    // the shared read layer indexes the whole recorded tool output before it can
    // answer anything. Every session after it is fast. Saying so beats letting a
    // minutes-long wait look like a hang.
    const firstCopilot = row.source === 'copilot' && !copilotWarmed;
    const leads = firstCopilot
      ? ['The first Copilot session takes a while to open — the rest of them will be quick.']
      : row.source === 'claude'
        ? ['Parsing the transcript and every sub-agent it spawned…']
        : ['Reading the recorded telemetry…'];
    return (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={44} stroke={3} />
        <p className="detail-loading-title">Reading session…</p>
        <p className="detail-loading-note">{rotatedNote(leads, note.tick, note.seed)}</p>
      </div>
    );
  }

  const runDeep = (): void => {
    setDeepConfirm(false);
    setDeepRunning(true);
    setDeepError(undefined);
    void dataHost
      .call('retro.deep', row.source, row.sessionId)
      .then(async (result) => {
        if (result.error !== undefined) {
          setDeepError(result.error);
          return;
        }
        // Swap the refreshed body in place, so the verdict appears in the card
        // without losing the open sections or the scroll position.
        const body = await dataHost.call('sessions.detailBody', row.source, row.sessionId);
        frameRef.current?.contentWindow?.postMessage({ type: 'update', html: body }, '*');
      })
      .catch((err: Error) => setDeepError(err.message))
      .finally(() => setDeepRunning(false));
  };

  return (
    <>
      <button
        type="button"
        className="icon-button detail-refresh"
        title="Refresh session"
        onClick={() => {
          forceRef.current = true;
          setRefreshToken((token) => token + 1);
        }}
      >
        <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M12 4a8 8 0 0 1 7.4 5h-2.2A6 6 0 0 0 6 12h3l-4 4.5L1 12h3a8 8 0 0 1 8-8Z" />
        </svg>
      </button>
      {onAskAi !== undefined && (
        <button
          type="button"
          className="detail-ask-ai"
          title="Attach this session to the AI Helper and ask about it"
          onClick={() => onAskAi(row.source, row.sessionId)}
        >
          Ask AI
        </button>
      )}
      {deepRunning && (
        <div className="deep-retro-status" role="status" aria-live="polite">
          <Spinner size={14} stroke={2} />
          <span>Writing the deep retrospective…</span>
        </div>
      )}
      {deepError !== undefined && (
        <div className="deep-retro-status deep-retro-error" role="alert">
          <span>{deepError}</span>
          <button type="button" className="icon-button" aria-label="Dismiss" onClick={() => setDeepError(undefined)}>
            ×
          </button>
        </div>
      )}
      {deepConfirm && (
        <DeepRetroDialog
          availability={deepAvailability}
          onRecheck={checkAvailability}
          onCancel={() => setDeepConfirm(false)}
          onConfirm={runDeep}
        />
      )}
      <iframe
        ref={frameRef}
        className="detail-frame"
        title={row.title ?? row.sessionId}
        // Scripts only: no same-origin, so the document cannot touch this app's
        // DOM, storage, or the preload bridge. It still enforces the strict
        // nonce policy declared in its own markup.
        sandbox="allow-scripts"
        src={docUrl}
      />
    </>
  );
}

/**
 * The per-invocation consent dialog for the deep retrospective — the second
 * gate after the Settings toggle. It states exactly what will be sent and to
 * whom; Escape, the backdrop, and the initially focused control all cancel,
 * following the DeleteDialog conventions. Confirming requires the Claude Code
 * CLI to actually be there: a missing install shows a blocking warning with
 * the way out, instead of a confusing failure after consent.
 */
function DeepRetroDialog({
  availability,
  onRecheck,
  onCancel,
  onConfirm,
}: {
  /** `undefined` while the probe is in flight. */
  availability?: AiAvailability;
  onRecheck: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}): JSX.Element {
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => cancelRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const cliMissing = availability !== undefined && !availability.available;

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="deep-retro-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="deep-retro-title">Send this session to be judged?</h2>
        <p>
          This sends the session&apos;s prompts, the assistant&apos;s responses, and its tool names
          to Anthropic through your own Claude Code login — the same account the session ran on. The
          written retrospective is stored only on this machine, and nothing here uses the cloud-sync
          path.
        </p>
        {cliMissing && (
          <div className="modal-warning" role="alert">
            <p>
              <strong>The Claude Code CLI was not found</strong> — this needs it to run.{' '}
              {availability.reason}
            </p>
            <p>
              Install it with <code>npm install -g @anthropic-ai/claude-code</code>, or set the CLI
              path under Settings → AI, then check again.
            </p>
            <button type="button" className="modal-btn" onClick={onRecheck}>
              Check again
            </button>
          </div>
        )}
        <div className="modal-actions">
          <button ref={cancelRef} type="button" className="modal-btn" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="modal-btn" onClick={onConfirm} disabled={cliMissing}>
            Send and judge
          </button>
        </div>
      </div>
    </div>
  );
}
