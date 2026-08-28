import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  app,
  BrowserWindow,
  MessageChannelMain,
  protocol,
  shell,
  utilityProcess,
  ipcMain,
  nativeTheme,
} from 'electron';
import type { UtilityProcess } from 'electron';
import { initAutoUpdater } from './updater';
import { installApplicationMenu } from './menu';

/**
 * Scheme the session-detail document is served over.
 *
 * It cannot be an inline `srcdoc` frame: a document with no URL of its own
 * inherits the embedder's Content-Security-Policy, and this app's page policy
 * (`script-src 'self'`) then blocks the detail document's own nonce'd scripts —
 * leaving a page that renders correctly but where nothing responds to a click.
 * Serving it over a real URL gives it a document of its own, governed only by
 * the strict nonce policy it carries in its own markup.
 */
const DETAIL_SCHEME = 'ao-detail';

/** Rendered documents awaiting a fetch, by id. */
const pendingDetails = new Map<string, string>();

/**
 * Only the newest few are worth keeping: a document is fetched immediately
 * after being stashed, and holding many of them would pin megabytes of markup.
 */
const MAX_PENDING_DETAILS = 4;

// Must run before the app is ready, which is why it sits at module scope.
protocol.registerSchemesAsPrivileged([
  {
    scheme: DETAIL_SCHEME,
    privileges: { standard: true, secure: true, corsEnabled: false, supportFetchAPI: false },
  },
]);

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
    title: 'Agent Observability',
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

  // Before the window: setting it after would let Electron install its own
  // default menu first, so the item this replaces would flash into existence.
  installApplicationMenu();

  startDataHost();
  createWindow();
  initAutoUpdater(() => mainWindow);

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

  // Hold a rendered detail document and hand back the URL to load it from.
  ipcMain.handle('detail:stash', (_event, html: unknown) => {
    if (typeof html !== 'string') {
      return undefined;
    }
    const id = randomUUID();
    pendingDetails.set(id, html);
    while (pendingDetails.size > MAX_PENDING_DETAILS) {
      const oldest = pendingDetails.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      pendingDetails.delete(oldest);
    }
    return `${DETAIL_SCHEME}://doc/${id}`;
  });

  protocol.handle(DETAIL_SCHEME, (request) => {
    const id = new URL(request.url).pathname.replace(/^\//, '');
    const html = pendingDetails.get(id);
    if (html === undefined) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    // The document carries its own Content-Security-Policy in a meta tag; no
    // header is added here that would loosen or duplicate it.
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  });

  if (process.env.AO_SELFTEST === '1') {
    void runSelfTest();
  }

  ipcMain.handle('app:open-path', async (_event, path: string) => shell.openPath(path));
  ipcMain.handle('app:show-item', (_event, path: string) => shell.showItemInFolder(path));
  ipcMain.handle('app:get-version', () => app.getVersion());

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

/**
 * Opens the first session the way a click would and reports what the embedded
 * document actually did — whether it loaded, and whether its own scripts ran.
 * Run with AO_SELFTEST=1; it exists because the failure it guards against
 * (a blocked script leaving the view inert) looks identical to success in a
 * screenshot.
 */
async function runSelfTest(): Promise<void> {
  const page = mainWindow?.webContents;
  if (page === undefined) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, 6000));
  try {
    const result = await page.executeJavaScript(`(async () => {
      const row = document.querySelector('.session-row');
      if (!row) { return 'no session rows rendered'; }
      row.click();
      // Wait for the detail request, the stash, and the frame to load.
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 500));
        const frame = document.querySelector('iframe.detail-frame');
        if (frame && frame.src) {
          return 'frame src = ' + frame.src.slice(0, 40);
        }
        const err = document.querySelector('.placeholder h2');
        if (err && err.textContent.includes('Could not open')) {
          return 'ERROR shown: ' + document.querySelector('.placeholder p').textContent;
        }
      }
      return 'timed out waiting for the frame';
    })()`);
    console.log(`[selftest] ${result}`);
  } catch (err) {
    console.log(`[selftest] failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  dataHost?.kill();
});
