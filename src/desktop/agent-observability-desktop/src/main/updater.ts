import { app, dialog, shell } from 'electron';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';

/**
 * Startup update check. Nothing downloads without consent: the app asks
 * before downloading and again before restarting.
 *
 * The repo is INTERNAL-visibility, so the feed is read through a fine-grained
 * PAT (contents: read, this repo only) baked in at build time — builds without
 * it (local packaging, forks) log one line and skip checks entirely.
 *
 * Windows installs updates itself. macOS builds are unsigned, and Squirrel.Mac
 * refuses to update an unsigned app, so that platform is notify-only: its
 * dialog links to the release page instead.
 */

const OWNER = 'turbinestudios';
const REPO = 'agent-observability';

/** Desktop releases are tagged `desktop-v<version>`. */
function releasePage(version: string): string {
  return `https://github.com/${OWNER}/${REPO}/releases/tag/desktop-v${version}`;
}

export function initAutoUpdater(getWindow: () => BrowserWindow | undefined): void {
  // AO_UPDATER_DEV=1 exercises the real feed from a dev run (pair it with
  // MAIN_VITE_UPDATE_TOKEN in the environment when the bundle is built).
  const devOverride = process.env.AO_UPDATER_DEV === '1';
  if (!app.isPackaged && !devOverride) {
    return;
  }

  const token = import.meta.env.MAIN_VITE_UPDATE_TOKEN;
  if (token === undefined || token === '') {
    console.log('[updater] built without an update token; update checks disabled');
    return;
  }

  if (devOverride) {
    // Bypasses electron-updater's own not-packaged guard.
    autoUpdater.forceDevUpdateConfig = true;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // Passing a token selects the authenticated provider, which resolves the
  // latest *published* release via the GitHub API — drafts stay invisible,
  // which is what makes the release workflow's draft a safe smoke-test gate.
  autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO, private: true, token });

  autoUpdater.on('error', (err) => {
    // Expected on every launch until the first updater-era release is
    // published (the API 404s); never worth a dialog.
    console.log(`[updater] ${err.message}`);
  });
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    void onUpdateAvailable(info, getWindow());
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    void onUpdateDownloaded(info, getWindow());
  });

  // Deferred so the first paint never competes with a dialog.
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => undefined); // failures land on 'error'
  }, 3000);
}

async function onUpdateAvailable(info: UpdateInfo, win: BrowserWindow | undefined): Promise<void> {
  if (process.platform === 'darwin') {
    const choice = await ask(win, {
      message: `Agent Observability ${info.version} is available`,
      detail: `You have ${app.getVersion()}. Download the new version and replace the app in Applications.`,
      buttons: ['Open download page', 'Later'],
    });
    if (choice === 0) {
      void shell.openExternal(releasePage(info.version));
    }
    return;
  }

  const choice = await ask(win, {
    message: `Agent Observability ${info.version} is available`,
    detail: `You have ${app.getVersion()}. Download and install it now?`,
    buttons: ['Update now', 'Later'],
  });
  if (choice === 0) {
    autoUpdater.downloadUpdate().catch(() => undefined); // failures land on 'error'
  }
}

/** Windows only in practice: the macOS branch never calls downloadUpdate(). */
async function onUpdateDownloaded(info: UpdateInfo, win: BrowserWindow | undefined): Promise<void> {
  const choice = await ask(win, {
    message: `Agent Observability ${info.version} is ready to install`,
    detail: 'Restart now, or it installs by itself when you quit.',
    buttons: ['Restart now', 'On next quit'],
  });
  if (choice === 0) {
    // install() runs first, then app.quit(): before-quit fires as on any
    // normal quit, so the data host is cleaned up (see index.ts).
    autoUpdater.quitAndInstall();
  }
  // Dismissed: autoInstallOnAppQuit finishes the job silently on quit.
}

async function ask(
  win: BrowserWindow | undefined,
  opts: { message: string; detail: string; buttons: string[] },
): Promise<number> {
  const options: MessageBoxOptions = { type: 'info', defaultId: 0, cancelId: 1, ...opts };
  const result =
    win !== undefined ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return result.response;
}
