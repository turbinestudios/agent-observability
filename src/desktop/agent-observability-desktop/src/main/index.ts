import { join } from 'node:path';
import { app, BrowserWindow, MessageChannelMain, shell, utilityProcess, ipcMain, nativeTheme } from 'electron';
import type { UtilityProcess } from 'electron';

/**
 * The main process is deliberately thin: it owns the window, the privileged
 * operations only it can perform (opening paths, OS theme), and the handshake
 * that connects the renderer directly to the data host.
 *
 * It does no parsing and opens no databases. Session work happens in the data
 * host utilityProcess, and the renderer reaches it over a MessagePort pair, so
 * a slow index pass can never block window input or painting.
 */

let mainWindow: BrowserWindow | undefined;
let dataHost: UtilityProcess | undefined;

/** Window backgrounds matching the renderer's `--bg` token per theme. */
const BACKGROUND: Record<'dark' | 'light', string> = {
  dark: '#16171a',
  light: '#ffffff',
};

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: `Agent Observability ${app.getVersion()}`,
    backgroundColor: nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
    },
  });

  // Show only once painted, so launch never flashes an empty white frame.
  mainWindow.once('ready-to-show', () => mainWindow?.show());

  // Renderer console output is invisible without devtools open, which makes a
  // startup failure look like an empty window. Forwarding it to stdout means
  // `AO_DEBUG=1 <app>` from a terminal shows what actually went wrong.
  if (process.env.AO_DEBUG === '1') {
    mainWindow.webContents.on('console-message', (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    mainWindow.webContents.on('render-process-gone', (_event, details) => {
      console.log(`[renderer] gone: ${details.reason}`);
    });
    mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
      console.log(`[preload] ${preloadPath}: ${error.message}`);
    });
  }

  // External links belong in the user's browser, never in an app window.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  const devServerUrl = process.env.ELECTRON_RENDERER_URL;
  if (devServerUrl !== undefined) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = undefined;
  });
}

function startDataHost(): void {
  dataHost = utilityProcess.fork(join(__dirname, 'datahost.js'), [], {
    serviceName: 'agent-observability-datahost',
    stdio: 'inherit',
  });
}

/**
 * Wire renderer ↔ data host. Each side gets one end of a channel; from then on
 * their messages travel directly, with main out of the path entirely.
 */
function connectRendererToDataHost(): void {
  if (mainWindow === undefined || dataHost === undefined) {
    return;
  }
  const { port1, port2 } = new MessageChannelMain();
  dataHost.postMessage({ type: 'renderer-port' }, [port1]);
  mainWindow.webContents.postMessage('datahost:port', null, [port2]);
  if (process.env.AO_DEBUG === '1') {
    console.log('[main] handed renderer a data-host port');
  }
}

app.whenReady().then(() => {
  // The app defaults to dark; setting themeSource before the window exists
  // makes the OS draw the title bar, menu bar, and system dialogs dark from
  // the first frame instead of flashing light chrome around a dark page. The
  // renderer re-asserts the stored choice once it mounts (theme:set below).
  nativeTheme.themeSource = 'dark';

  startDataHost();
  createWindow();

  // The renderer owns the theme choice (persisted on its side); main mirrors
  // it into the window chrome. Values are constrained to the two we ship.
  ipcMain.on('theme:set', (_event, theme: unknown) => {
    if (theme !== 'dark' && theme !== 'light') {
      return;
    }
    nativeTheme.themeSource = theme;
    mainWindow?.setBackgroundColor(BACKGROUND[theme]);
  });

  // The renderer asks for its port once its listener is installed, so the
  // handshake cannot race a slow first paint.
  ipcMain.on('datahost:request-port', () => connectRendererToDataHost());

  ipcMain.handle('app:open-external', async (_event, url: string) => {
    // Only real web links; a file:// or custom scheme here would hand arbitrary
    // local paths to the OS handler.
    if (/^https?:\/\//i.test(url)) {
      await shell.openExternal(url);
    }
  });

  ipcMain.handle('app:open-path', async (_event, path: string) => shell.openPath(path));
  ipcMain.handle('app:show-item', (_event, path: string) => shell.showItemInFolder(path));
  ipcMain.handle('app:get-version', () => app.getVersion());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  dataHost?.kill();
});
