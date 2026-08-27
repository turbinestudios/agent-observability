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
      const payload = (event.data as { __aoDetail?: { type?: string; path?: string } })?.__aoDetail;
      if (payload?.type === 'open-context-file' && typeof payload.path === 'string') {
        void window.desktop.openPath(payload.path);
      }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

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
    return (
      <div className="placeholder">
        <div>
          <p>Reading session…</p>
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
