import { app, dialog, shell } from 'electron';
import type { BrowserWindow, MessageBoxOptions } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo, ProgressInfo } from 'electron-updater';
import { UPDATE_STATUS_CHANNEL, downloadingStatus } from '../shared/updates';
import type { UpdateStatus } from '../shared/updates';

/**
 * Startup update check. Nothing downloads without consent: the app asks
 * before downloading and again before restarting.
 *
 * The repo is public, so the feed needs no credentials. Only official release
 * builds check it: the release workflow sets MAIN_VITE_ENABLE_UPDATES=1 at build
 * time, and builds without it (local packaging, forks) log one line and skip
 * checks entirely, so a fork is never offered upstream's installers.
 *
 * Windows installs updates itself. macOS builds are unsigned, and Squirrel.Mac
 * refuses to update an unsigned app, so that platform is notify-only: its
 * dialog links to the release page instead.
 *
 * The gap between the two dialogs is a real download — a minute or more on a
 * slow line — and it used to be entirely silent, which reads as a hung app. It
 * is now reported twice over: to the window as an {@link UpdateStatus} the
 * sidebar renders, and to the OS through the taskbar/dock progress bar, so the
 * download is visible even when the window is not.
 */

const OWNER = 'turbinestudios';
const REPO = 'agent-observability';

/** Desktop releases are tagged `desktop-v<version>`. */
function releasePage(version: string): string {
  return `https://github.com/${OWNER}/${REPO}/releases/tag/desktop-v${version}`;
}

/**
 * True from the moment a download is consented to until it ends. The 'error'
 * handler is noisy — it fires on every launch until the first release exists —
 * so only a failure while THIS is set is a failure the user is waiting on.
 */
let downloading = false;

/** The version being fetched, so a progress event can name it. */
let pendingVersion = '';

export function initAutoUpdater(getWindow: () => BrowserWindow | undefined): void {
  // AO_UPDATER_DEV=1 exercises the real feed from a dev run (pair it with
  // MAIN_VITE_ENABLE_UPDATES=1 in the environment when the bundle is built).
  const devOverride = process.env.AO_UPDATER_DEV === '1';
  if (!app.isPackaged && !devOverride) {
    return;
  }

  if (import.meta.env.MAIN_VITE_ENABLE_UPDATES !== '1') {
    console.log('[updater] not an official release build; update checks disabled');
    return;
  }

  if (devOverride) {
    // Bypasses electron-updater's own not-packaged guard.
    autoUpdater.forceDevUpdateConfig = true;
  }

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  // The public provider resolves the latest *published* release from the
  // repo's release feed. Drafts never appear there, which is what makes the
  // release workflow's draft a safe smoke-test gate.
  autoUpdater.setFeedURL({ provider: 'github', owner: OWNER, repo: REPO });

  autoUpdater.on('error', (err) => {
    // Expected on every launch until the first updater-era release is
    // published (the API 404s); never worth a dialog.
    console.log(`[updater] ${err.message}`);
    if (downloading) {
      // A failure the user IS waiting on, though: they pressed Update and the
      // bar would otherwise sit where it stalled, forever.
      downloading = false;
      publish(getWindow(), { phase: 'failed', message: err.message });
    }
  });
  autoUpdater.on('update-available', (info: UpdateInfo) => {
    void onUpdateAvailable(info, getWindow());
  });
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    publish(getWindow(), downloadingStatus(pendingVersion, progress));
  });
  autoUpdater.on('update-downloaded', (info: UpdateInfo) => {
    downloading = false;
    publish(getWindow(), { phase: 'downloaded', version: info.version });
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
    downloading = true;
    pendingVersion = info.version;
    // Published before the first byte arrives: electron-updater can take
    // seconds to resolve the asset, and that silence is the complaint.
    publish(win, downloadingStatus(info.version, { percent: 0, transferred: 0, total: 0, bytesPerSecond: 0 }));
    autoUpdater.downloadUpdate().catch(() => undefined); // failures land on 'error'
  }
}

/**
 * Send a status to the window, and mirror it onto the taskbar/dock progress
 * bar so a minimized app still shows the download moving.
 *
 * `setProgressBar(-1)` is how Electron clears the bar; anything else leaves a
 * finished download showing as permanently in-progress on the taskbar.
 */
function publish(win: BrowserWindow | undefined, status: UpdateStatus): void {
  if (win === undefined || win.isDestroyed()) {
    return;
  }
  win.webContents.send(UPDATE_STATUS_CHANNEL, status);
  win.setProgressBar(status.phase === 'downloading' ? status.percent / 100 : -1);
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
