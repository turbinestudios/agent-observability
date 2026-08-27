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

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16171a' : '#ffffff',
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
}

app.whenReady().then(() => {
  startDataHost();
  createWindow();

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
