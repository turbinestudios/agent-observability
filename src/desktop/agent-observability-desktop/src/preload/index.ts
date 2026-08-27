import { contextBridge, ipcRenderer } from 'electron';

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

  /** Mirror the app's theme into the native window chrome (title bar, menus). */
  setNativeTheme(theme: 'dark' | 'light'): void {
    ipcRenderer.send('theme:set', theme);
  },
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('desktop', api);
