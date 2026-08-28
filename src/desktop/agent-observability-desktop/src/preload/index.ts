import { contextBridge, ipcRenderer } from 'electron';
import { UPDATE_STATUS_CHANNEL } from '../shared/updates';
import type { UpdateStatus } from '../shared/updates';

/**
 * The only bridge between the renderer and Node.
 *
 * `contextIsolation` is on and nothing but the functions below is exposed — the
 * renderer never sees `ipcRenderer`, `require`, or the filesystem. Session data
 * arrives over a MessagePort instead of through this surface, so the privileged
 * API stays small enough to audit at a glance.
 */

/** Message the page listens for to pick up its data-host port. */
export const DATA_HOST_PORT_MESSAGE = 'agent-observability:datahost-port';

/**
 * Hand the data-host port to the page.
 *
 * A MessagePort cannot be passed through contextBridge — it arrives as a proxy
 * with its prototype stripped, so calling `start()` on it throws. Transferring
 * it with `window.postMessage` moves the real object into the page's world,
 * which is the only way it stays a working port.
 */
ipcRenderer.on('datahost:port', (event) => {
  const [port] = event.ports;
  if (port !== undefined) {
    window.postMessage({ type: DATA_HOST_PORT_MESSAGE }, '*', [port]);
  }
});

const api = {
  /**
   * Ask main to connect this renderer to the data host. The port arrives as a
   * `window.postMessage` carrying {@link DATA_HOST_PORT_MESSAGE}; install that
   * listener before calling this.
   */
  requestDataHostPort(): void {
    ipcRenderer.send('datahost:request-port');
  },

  /** The message type that carries the transferred port. */
  dataHostPortMessage: DATA_HOST_PORT_MESSAGE,

  /** Open a web link in the user's default browser. */
  openExternal(url: string): Promise<void> {
    return ipcRenderer.invoke('app:open-external', url);
  },

  /** Open a local file with its default application. */
  openPath(path: string): Promise<string> {
    return ipcRenderer.invoke('app:open-path', path);
  },

  /** Reveal a local file in Finder/Explorer. */
  showItem(path: string): Promise<void> {
    return ipcRenderer.invoke('app:show-item', path);
  },

  getVersion(): Promise<string> {
    return ipcRenderer.invoke('app:get-version');
  },

  /**
   * Subscribe to update progress. Returns an unsubscribe function — React
   * mounts effects twice under StrictMode, so a listener that could not be
   * removed would double up and the sidebar would fight itself.
   */
  onUpdateStatus(listener: (status: UpdateStatus) => void): () => void {
    const handler = (_event: unknown, status: UpdateStatus): void => listener(status);
    ipcRenderer.on(UPDATE_STATUS_CHANNEL, handler);
    return () => {
      ipcRenderer.off(UPDATE_STATUS_CHANNEL, handler);
    };
  },

  /** Mirror the app's theme into the native window chrome (title bar, menus). */
  setNativeTheme(theme: 'dark' | 'light'): void {
    ipcRenderer.send('theme:set', theme);
  },

  /**
   * Hand a rendered session-detail document to the main process and get back a
   * URL to load it from. It is served as a document of its own rather than
   * inlined into a frame, so it keeps its own strict script policy instead of
   * inheriting this page's — which would block the scripts it needs.
   */
  stashDetail(html: string): Promise<string | undefined> {
    return ipcRenderer.invoke('detail:stash', html);
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('desktop', api);
