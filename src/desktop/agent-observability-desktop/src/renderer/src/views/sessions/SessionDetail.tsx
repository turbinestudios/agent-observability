import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { dataHost } from '../../api/client';
import type { SessionRow } from '../../../../shared/rpc';
import { useThemeValue } from '../../theme/ThemeContext';

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

export function SessionDetail({ row }: Props): JSX.Element {
  const { theme } = useThemeValue();
  const [html, setHtml] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);

    dataHost
      .call('sessions.detail', row.source, row.sessionId, theme)
      .then((doc) => {
        if (row.source === 'copilot') {
          copilotWarmed = true;
        }
        // A slow parse must not overwrite a newer selection.
        if (!cancelled) {
          setHtml(doc);
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
  }, [row.source, row.sessionId, row.indexedAtMs, theme]);

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
  }, [row.source, row.sessionId]);

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

  if (loading || html === undefined) {
    // The first Copilot session opened in a run pays a large one-time cost:
    // the shared read layer indexes the whole recorded tool output before it can
    // answer anything. Every session after it is fast. Saying so beats letting a
    // minutes-long wait look like a hang.
    const firstCopilot = row.source === 'copilot' && !copilotWarmed;
    return (
      <div className="placeholder">
        <div>
          <p>Reading session…</p>
          {firstCopilot && (
            <p style={{ color: 'var(--fg-subtle)', marginTop: 6, maxWidth: '42ch' }}>
              The first Copilot session takes a while to open — the rest of them will be quick.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <iframe
      ref={frameRef}
      className="detail-frame"
      title={row.title ?? row.sessionId}
      // Scripts only: no same-origin, so the document cannot touch this app's
      // DOM, storage, or the preload bridge.
      sandbox="allow-scripts"
      srcDoc={html}
    />
  );
}
