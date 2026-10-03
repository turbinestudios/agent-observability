import type { JSX } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ASSISTANT_QUICK_PROMPTS } from '@agent-observability/core/src/chat/tasks/assistantGrounding';
import type { AiAvailability, AiBackendInfo, AiChatState, SessionRef } from '../../../../shared/rpc';
import { dataHost } from '../../api/client';
import { Spinner } from '../../components/Spinner';
import './assistant.css';

/**
 * The AI Helper: a chat grounded in the user's own local session data, run
 * through their own AI CLI login — Claude Code, or the GitHub Copilot CLI when
 * Settings selects it.
 *
 * The thread lives in the datahost (`ai.state` restores it on remount); this
 * view owns only the input box, the not-yet-sent attach chip, and the
 * streaming bubble. Assistant markup arrives host-rendered — the renderer has
 * no markdown parser by design — and is inserted as innerHTML behind the strict
 * CSP; clicks are intercepted below so a citation opens the Sessions view and
 * an external link opens the OS browser, never this window.
 */

/**
 * What another view asked the helper to do: focus on a session ("Ask AI"
 * from the Sessions view), or start from a question ("Ask AI Helper about
 * this repository" from the Workspace). A prefilled question only fills the
 * box — nothing is sent until the user presses Send.
 */
export interface AskAiIntent {
  source?: string;
  sessionId?: string;
  prefill?: string;
  /** Distinguishes two asks for the same session, like `OpenSessionIntent`. */
  at: number;
}

interface Props {
  onOpenSession: (source: string, sessionId: string) => void;
  askIntent?: AskAiIntent;
}

/** The attach chip's display state: the ref plus a human-readable label. */
interface FocusChip extends SessionRef {
  label: string;
}

export function AssistantView({ onOpenSession, askIntent }: Props): JSX.Element {
  const [availability, setAvailability] = useState<AiAvailability | undefined>(undefined);
  // The ACTIVE backend, so every line of copy names the CLI and vendor a send
  // would actually go to — "Claude Code / Anthropic" must not be hardcoded now
  // that Settings can route through the GitHub Copilot CLI instead.
  const [backend, setBackend] = useState<AiBackendInfo | undefined>(undefined);
  const [chat, setChat] = useState<AiChatState | undefined>(undefined);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [streamHtml, setStreamHtml] = useState<string | undefined>(undefined);
  const [pendingText, setPendingText] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [focus, setFocus] = useState<FocusChip | undefined>(undefined);
  const logRef = useRef<HTMLDivElement | null>(null);

  const refresh = useCallback(() => {
    dataHost
      .call('ai.state')
      .then(setChat)
      .catch((err: Error) => setError(err.message));
  }, []);

  const checkAvailability = useCallback(() => {
    dataHost
      .call('ai.availability')
      .then(setAvailability)
      .catch((err: Error) => setAvailability({ available: false, reason: err.message }));
    dataHost
      .call('ai.backends')
      .then((all) => setBackend(all.find((b) => b.active)))
      .catch(() => setBackend(undefined));
  }, []);

  useEffect(() => {
    refresh();
    checkAvailability();
    return dataHost.on('ai.assistantDelta', (event) => {
      if (event.event === 'ai.assistantDelta') {
        setStreamHtml(event.html);
      }
    });
  }, [refresh, checkAvailability]);

  // "Ask AI" from a session: attach it and show its name on the chip.
  useEffect(() => {
    if (askIntent === undefined) {
      return;
    }
    if (askIntent.prefill !== undefined) {
      setInput(askIntent.prefill);
    }
    const { source, sessionId } = askIntent;
    if (source === undefined || sessionId === undefined) {
      return;
    }
    setFocus({ source, sessionId, label: sessionId });
    void dataHost.call('sessions.row', source, sessionId).then((row) => {
      if (row?.title !== undefined) {
        setFocus((current) =>
          current?.source === source && current.sessionId === sessionId
            ? { ...current, label: row.title as string }
            : current,
        );
      }
    });
  }, [askIntent]);

  // Keep the newest turn in view while an answer streams in.
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [chat, streamHtml, sending]);

  const busy = sending || chat?.busy === true;

  const send = useCallback(
    (params: { text?: string; quickPromptId?: string }) => {
      if (busy) {
        return;
      }
      const shown =
        params.text ?? ASSISTANT_QUICK_PROMPTS.find((p) => p.id === params.quickPromptId)?.prompt ?? '';
      setSending(true);
      setError(undefined);
      setStreamHtml(undefined);
      setPendingText(shown);
      dataHost
        .call('ai.send', {
          ...params,
          ...(focus !== undefined ? { focus: { source: focus.source, sessionId: focus.sessionId } } : {}),
        })
        .then((result) => {
          if (!result.ok && result.error !== undefined) {
            setError(result.error);
            // The send was refused, so the question was not recorded — put it
            // back in the box rather than losing what the user typed.
            if (params.text !== undefined) {
              setInput(params.text);
            }
          }
        })
        .catch((err: Error) => setError(err.message))
        .finally(() => {
          setSending(false);
          setStreamHtml(undefined);
          setPendingText(undefined);
          refresh();
        });
    },
    [busy, focus, refresh],
  );

  const sendTyped = useCallback(() => {
    const text = input.trim();
    if (text.length === 0) {
      return;
    }
    setInput('');
    send({ text });
  }, [input, send]);

  // One interception point for everything the assistant writes: citations
  // (`data-source`/`data-id`, no href) open the session; real links open the
  // OS browser. Nothing an answer contains may navigate this window.
  const onLogClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>) => {
      const anchor = (event.target as HTMLElement).closest('a');
      if (anchor === null) {
        return;
      }
      event.preventDefault();
      const source = anchor.getAttribute('data-source');
      const id = anchor.getAttribute('data-id');
      if (source !== null && id !== null) {
        onOpenSession(source, id);
        return;
      }
      const href = anchor.getAttribute('href');
      if (href !== null) {
        void window.desktop.openExternal(href);
      }
    },
    [onOpenSession],
  );

  if (chat === undefined || availability === undefined) {
    return (
      <div className="detail-loading" role="status" aria-live="polite">
        <Spinner size={36} stroke={3} />
        <p className="detail-loading-title">Getting ready…</p>
      </div>
    );
  }

  if (!availability.available) {
    return <CliMissingHero backend={backend} reason={availability.reason} onRecheck={checkAvailability} />;
  }

  if (!chat.acknowledged) {
    return (
      <FirstUseNotice
        backend={backend}
        onAccept={() => {
          void dataHost.call('ai.acknowledge').then(refresh);
        }}
      />
    );
  }

  const empty = chat.messages.length === 0 && pendingText === undefined;

  return (
    <div className="assistant-view">
      <header className="assistant-header">
        <div className="assistant-header-inner">
          <h1>AI Helper</h1>
          <p>
            Ask about your own sessions — what you worked on, what struggled and why, where the
            tokens went. Runs through your own {backend?.label ?? 'AI'} CLI on this machine.
          </p>
        </div>
      </header>

      <div className="assistant-log" ref={logRef} onClick={onLogClick}>
        <div className="assistant-log-inner">
        {empty ? (
          <div className="assistant-empty">
            <p>Try one of these, or ask in your own words:</p>
            <div className="assistant-quick">
              {ASSISTANT_QUICK_PROMPTS.map((prompt) => (
                <button
                  key={prompt.id}
                  type="button"
                  className="assistant-quick-chip"
                  title={prompt.prompt}
                  onClick={() => send({ quickPromptId: prompt.id })}
                >
                  {prompt.label}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {chat.messages.map((message, index) =>
              message.role === 'assistant' ? (
                <div
                  key={index}
                  className="assistant-bubble assistant-bubble-model"
                  dangerouslySetInnerHTML={{ __html: message.html ?? '' }}
                />
              ) : (
                <div key={index} className="assistant-bubble assistant-bubble-user">
                  {message.text}
                </div>
              ),
            )}
            {pendingText !== undefined && (
              <div className="assistant-bubble assistant-bubble-user">{pendingText}</div>
            )}
            {busy &&
              (streamHtml !== undefined && streamHtml.length > 0 ? (
                <div
                  className="assistant-bubble assistant-bubble-model"
                  dangerouslySetInnerHTML={{ __html: streamHtml }}
                />
              ) : (
                <div className="assistant-bubble assistant-bubble-model assistant-thinking">
                  <Spinner size={16} stroke={2} /> Thinking…
                </div>
              ))}
          </>
        )}
        </div>
      </div>

      {error !== undefined && (
        <div className="assistant-error" role="alert">
          <span>{error}</span>
          <button type="button" onClick={() => setError(undefined)} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      <footer className="assistant-composer">
        <div className="assistant-composer-inner">
        {focus !== undefined && (
          <div className="assistant-focus" title="Questions about “this session” mean the attached one">
            Asking about <strong>{focus.label}</strong>
            <button
              type="button"
              aria-label="Detach session"
              onClick={() => setFocus(undefined)}
              disabled={busy}
            >
              ×
            </button>
          </div>
        )}
        <div className="assistant-input-row">
          <textarea
            className="assistant-input"
            placeholder="Ask about your sessions… (Enter sends, Shift+Enter for a new line)"
            value={input}
            rows={2}
            disabled={busy}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendTyped();
              }
            }}
          />
          {busy ? (
            <button type="button" className="assistant-stop" onClick={() => void dataHost.call('ai.stop')}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              className="assistant-send"
              onClick={sendTyped}
              disabled={input.trim().length === 0}
            >
              Send
            </button>
          )}
        </div>
        <div className="assistant-footnote">
          <span>
            Each message sends your question and a summary of recent sessions
            {focus !== undefined ? ', plus excerpts of the attached session,' : ''} through your own{' '}
            {backend?.label ?? 'AI'} CLI.
          </span>
          {!empty && (
            <button
              type="button"
              className="assistant-new-chat"
              disabled={busy}
              onClick={() => {
                void dataHost.call('ai.reset').then(() => {
                  setFocus(undefined);
                  setError(undefined);
                  setStreamHtml(undefined);
                  refresh();
                });
              }}
            >
              New chat
            </button>
          )}
        </div>
        </div>
      </footer>
    </div>
  );
}

/** Blocking state: the feature cannot work without the CLI, so say so loudly. */
function CliMissingHero({
  backend,
  reason,
  onRecheck,
}: {
  backend?: AiBackendInfo;
  reason?: string;
  onRecheck: () => void;
}): JSX.Element {
  const label = backend?.label ?? 'AI';
  return (
    <div className="assistant-hero" role="alert">
      <div>
        <h2>The AI Helper needs the {label} CLI</h2>
        <p>{reason ?? `The ${label} CLI was not found on this machine.`}</p>
        <p>
          Point the app at an existing install — or switch backends — under{' '}
          <strong>Settings → AI</strong>.
        </p>
        <button type="button" className="assistant-hero-action" onClick={onRecheck}>
          Check again
        </button>
      </div>
    </div>
  );
}

/** The one-time consent notice. The datahost refuses sends until it is accepted. */
function FirstUseNotice({
  backend,
  onAccept,
}: {
  backend?: AiBackendInfo;
  onAccept: () => void;
}): JSX.Element {
  return (
    <div className="assistant-hero assistant-notice">
      <div>
        <h2>Before you ask</h2>
        <p>
          Answers are grounded in your local sessions. Each message you send carries your question,
          a summary of your recent sessions — titles, repositories, verdicts, token and cost
          figures — and, when you attach a session, capped excerpts of its prompts and responses.
        </p>
        <p>
          It all goes to {backend?.vendor ?? 'the AI vendor'} through{' '}
          <strong>your own {backend?.label ?? 'AI'} CLI login</strong> on this machine — whichever
          backend Settings selects: no API key of this app, nothing in the background, and nothing
          on the cloud-sync path — that continues to carry no raw content, ever.
        </p>
        <button type="button" className="assistant-hero-action" onClick={onAccept}>
          I understand — continue
        </button>
      </div>
    </div>
  );
}
