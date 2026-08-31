import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { AiAvailability, AiBackendInfo, SessionRow, TagCount } from '../../../../shared/rpc';
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
  // The active backend, so the consent copy names the actual vendor and CLI.
  const [deepBackend, setDeepBackend] = useState<AiBackendInfo | undefined>(undefined);
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
    dataHost
      .call('ai.backends')
      .then((all) => setDeepBackend(all.find((b) => b.active)))
      .catch(() => setDeepBackend(undefined));
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
    <div className="detail-shell">
      {/*
        The annotation strip. Everything here is the app's own chrome, kept
        deliberately OUTSIDE the sandboxed frame: the document renders session
        content, which is arbitrary text from a model or a repository, and it
        must never be able to draw or read the controls that write to disk.
      */}
      <Annotations
        row={row}
        actions={
          <>
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
            <button
              type="button"
              className="icon-button"
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
          </>
        }
      />
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
          backend={deepBackend}
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
    </div>
  );
}

/** How long typing pauses before a note is written. */
const NOTE_SAVE_DELAY_MS = 500;

/**
 * Tags and a note for the open session, above the document.
 *
 * Both are LOCAL-ONLY user data: they are kept in JSON stores beside the index
 * so a rebuild cannot lose them, and they are never added to the AI Helper's
 * grounding or the deep retrospective's digest — those two paths state exactly
 * what they send, and quietly widening either would break the consent the user
 * gave.
 */
function Annotations({ row, actions }: { row: SessionRow; actions: JSX.Element }): JSX.Element {
  // The component is keyed by session in the list, so this seeds once per
  // session; the effect below follows later edits made from the row itself.
  const [tags, setTags] = useState<string[]>(row.tags ?? []);
  const [known, setKnown] = useState<TagCount[]>([]);
  const [adding, setAdding] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [note, setNote] = useState('');
  const [noteLoaded, setNoteLoaded] = useState(false);

  // Keyed on the serialized VALUE, not the array: a pushed row carries a fresh
  // array on every index tick whether or not the tags changed, and re-seeding
  // on each of those would fight whatever is being edited here. Serialized
  // rather than joined on a separator, so a tag containing one cannot split.
  const incoming = JSON.stringify(row.tags ?? []);
  useEffect(() => {
    setTags(JSON.parse(incoming) as string[]);
  }, [incoming]);

  // The suggestions only move when tags do, so this follows them rather than
  // re-fetching on every render.
  useEffect(() => {
    void dataHost
      .call('tags.list')
      .then(setKnown)
      .catch(() => undefined);
  }, [incoming]);

  // The note body is fetched per session rather than carried on every list row.
  useEffect(() => {
    let cancelled = false;
    void dataHost
      .call('sessions.note', row.source, row.sessionId)
      .then((text) => {
        if (!cancelled) {
          setNote(text);
          setNoteLoaded(true);
          // Open on arrival when there is something to read: a note exists to
          // be seen, and hiding it behind a toggle would waste it.
          setNoteOpen(text.length > 0);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setNoteLoaded(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [row.source, row.sessionId]);

  const commitTags = (next: string[]): void => {
    setAdding(false);
    setTags(next);
    void dataHost.call('sessions.setTags', row.source, row.sessionId, next).catch(() => undefined);
  };

  /**
   * Saving is debounced while typing, and flushed on unmount — closing the pane
   * or switching sessions mid-sentence must not be how a note is lost.
   */
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const pending = useRef<string | undefined>(undefined);
  const target = useRef({ source: row.source, sessionId: row.sessionId });
  target.current = { source: row.source, sessionId: row.sessionId };

  const flush = useCallback(() => {
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
      timer.current = undefined;
    }
    const text = pending.current;
    pending.current = undefined;
    if (text === undefined) {
      return;
    }
    const { source, sessionId } = target.current;
    void dataHost.call('sessions.setNote', source, sessionId, text).catch(() => undefined);
  }, []);

  useEffect(() => flush, [flush]);

  const editNote = (text: string): void => {
    setNote(text);
    pending.current = text;
    if (timer.current !== undefined) {
      clearTimeout(timer.current);
    }
    timer.current = setTimeout(flush, NOTE_SAVE_DELAY_MS);
  };

  return (
    <>
      <div className="detail-annotations">
        <div className="detail-tags">
          {tags.map((tag) => (
            <span key={tag} className="detail-tag">
              {tag}
              <button
                type="button"
                className="detail-tag-remove"
                aria-label={`Remove tag ${tag}`}
                title={`Remove "${tag}"`}
                onClick={() => commitTags(tags.filter((t) => t !== tag))}
              >
                ×
              </button>
            </span>
          ))}
          {adding ? (
            <AddTagInput
              known={known}
              onCancel={() => setAdding(false)}
              onCommit={(tag) => commitTags([...tags, tag])}
            />
          ) : (
            <button type="button" className="detail-tag-add" onClick={() => setAdding(true)}>
              + Tag
            </button>
          )}
        </div>
        <button
          type="button"
          className="detail-note-toggle"
          aria-expanded={noteOpen}
          onClick={() => setNoteOpen((open) => !open)}
        >
          {note.length > 0 ? 'Note' : '+ Note'}
        </button>
        <div className="detail-actions">{actions}</div>
      </div>
      {noteOpen && noteLoaded && (
        <textarea
          className="detail-note"
          value={note}
          aria-label="Note about this session"
          placeholder="What happened in this run, and what you would change."
          rows={3}
          onChange={(e) => editNote(e.target.value)}
          onBlur={flush}
        />
      )}
    </>
  );
}

/**
 * One new tag, with the tags already in use offered as suggestions — a native
 * datalist, because picking an existing tag rather than retyping it is what
 * keeps a corpus from quietly splitting in two over a capital letter.
 */
function AddTagInput({
  known,
  onCancel,
  onCommit,
}: {
  known: TagCount[];
  onCancel: () => void;
  onCommit: (tag: string) => void;
}): JSX.Element {
  const [value, setValue] = useState('');
  const done = useRef(false);

  const commit = (): void => {
    if (done.current) {
      return; // blur fires after Enter; only the first one counts
    }
    done.current = true;
    const tag = value.trim();
    if (tag.length === 0) {
      onCancel();
    } else {
      onCommit(tag);
    }
  };

  return (
    <>
      <input
        className="detail-tag-input"
        autoFocus
        value={value}
        list="detail-known-tags"
        aria-label="New tag"
        placeholder="experiment-A"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            done.current = true;
            onCancel();
          }
        }}
      />
      <datalist id="detail-known-tags">
        {known.map((tag) => (
          <option key={tag.tag} value={tag.tag} />
        ))}
      </datalist>
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
  backend,
  onRecheck,
  onCancel,
  onConfirm,
}: {
  /** `undefined` while the probe is in flight. */
  availability?: AiAvailability;
  /** The active backend, naming the vendor the digest would go to. */
  backend?: AiBackendInfo;
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
          to <strong>{backend?.vendor ?? 'the AI vendor'}</strong> through your own{' '}
          {backend?.label ?? 'AI'} CLI login. The written retrospective is stored only on this
          machine, and nothing here uses the cloud-sync path.
        </p>
        {cliMissing && (
          <div className="modal-warning" role="alert">
            <p>
              <strong>The {backend?.label ?? 'AI'} CLI was not found</strong> — this needs it to
              run. {availability.reason}
            </p>
            <p>Fix the CLI path — or switch backends — under Settings → AI, then check again.</p>
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
