import { contextBridge, ipcRenderer } from 'electron';

/**
 * The only bridge between the renderer and Node.
 *
 * `contextIsolation` is on and nothing but the functions below is exposed — the
 * renderer never sees `ipcRenderer`, `require`, or the filesystem. Session data
 * arrives over a MessagePort instead of through this surface, so the privileged
 * API stays small enough to audit at a glance.
 */

const api = {
  /**
   * Ask main to connect this renderer to the data host. The port arrives as a
   * `datahost:port` message; call this only after `onDataHostPort` is installed.
   */
  requestDataHostPort(): void {
    ipcRenderer.send('datahost:request-port');
  },

  /** Register the handler that receives the data-host MessagePort. */
  onDataHostPort(handler: (port: MessagePort) => void): void {
    ipcRenderer.on('datahost:port', (event) => {
      const [port] = event.ports;
      if (port !== undefined) {
        handler(port as unknown as MessagePort);
      }
    });
  },

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
};

export type DesktopApi = typeof api;

contextBridge.exposeInMainWorld('desktop', api);
