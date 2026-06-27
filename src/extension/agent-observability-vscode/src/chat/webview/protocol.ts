/**
 * The postMessage protocol between the AI Helper webview and the extension host.
 *
 * Pure type declarations (no `vscode`), shared by `chatViewProvider.ts` (host)
 * and the inline webview script in `chatViewHtml.ts`. Markdown is rendered on the
 * HOST (`markdownToHtml.ts`) and sent as ready HTML, so the webview never parses
 * model output itself.
 */

/** Which generated config an Apply button targets. */
export type ApplyKind = 'workflows' | 'config';

/** Messages sent FROM the webview TO the extension host. */
export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'runQuickCommand'; id: string }
  | { type: 'stop' }
  | { type: 'applyConfig'; kind: ApplyKind; code: string }
  | { type: 'copy'; text: string };

/** Messages sent FROM the extension host TO the webview. */
export type HostToWebview =
  | { type: 'busy'; busy: boolean }
  | { type: 'userEcho'; text: string }
  | { type: 'assistantStart'; id: string }
  | { type: 'assistantHtml'; id: string; html: string }
  | { type: 'assistantDone'; id: string }
  | { type: 'error'; message: string }
  | { type: 'applied'; ok: boolean; message: string }
  | { type: 'reset' };
