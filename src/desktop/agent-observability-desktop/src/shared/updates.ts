/**
 * What the main process tells the window while an update is being fetched.
 *
 * The consent dialogs live in the main process and are native, but the download
 * between them is not: pressing **Update now** used to be followed by a silent
 * minute, which reads as a hung app rather than a working one. These statuses
 * are what fills that gap.
 *
 * Pure types and formatting, imported by main, preload and the renderer alike,
 * so the three cannot disagree about the shape of a message that crosses two
 * process boundaries.
 */

/** IPC channel the main process publishes {@link UpdateStatus} on. */
export const UPDATE_STATUS_CHANNEL = 'update:status';

/** Progress as `electron-updater` reports it. */
export interface DownloadProgress {
  /** 0–100, and occasionally NaN when the feed reports no content length. */
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
}

export type UpdateStatus =
  | {
      phase: 'downloading';
      version: string;
      /** Always 0–100 and finite; see {@link downloadingStatus}. */
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  /** Fetched and staged. Installs on restart, or by itself on the next quit. */
  | { phase: 'downloaded'; version: string }
  | { phase: 'failed'; message: string };

/**
 * Normalize one `download-progress` event.
 *
 * The percentage is clamped and de-NaN'd here rather than in the view: a feed
 * that serves the asset without a content length reports `total: 0`, and the
 * resulting NaN would otherwise reach the DOM as a bar of width `NaN%` — an
 * invisible, silently broken indicator, which is the exact failure this whole
 * feature exists to prevent.
 */
export function downloadingStatus(version: string, progress: DownloadProgress): UpdateStatus {
  const { percent, transferred, total, bytesPerSecond } = progress;
  return {
    phase: 'downloading',
    version,
    percent: Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0,
    transferred: atLeastZero(transferred),
    total: atLeastZero(total),
    bytesPerSecond: atLeastZero(bytesPerSecond),
  };
}

function atLeastZero(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The percentage, as the narrow sidebar shows it. */
export function formatPercent(status: UpdateStatus): string {
  return status.phase === 'downloading' ? `${Math.round(status.percent)}%` : '';
}

/**
 * The full sentence, for the tooltip — the sidebar is 52px wide, so everything
 * beyond a percentage has to live somewhere the user can hover for it.
 */
export function describeStatus(status: UpdateStatus): string {
  switch (status.phase) {
    case 'downloading': {
      const size =
        status.total > 0
          ? `${formatBytes(status.transferred)} of ${formatBytes(status.total)}`
          : formatBytes(status.transferred);
      const rate = status.bytesPerSecond > 0 ? `, ${formatBytes(status.bytesPerSecond)}/s` : '';
      return `Downloading ${status.version} — ${size}${rate}`;
    }
    case 'downloaded':
      return `${status.version} is ready — restart to install it`;
    case 'failed':
      return `Update failed — ${status.message}`;
  }
}

/** Bytes at three significant figures, which keeps the tooltip a stable width. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}
