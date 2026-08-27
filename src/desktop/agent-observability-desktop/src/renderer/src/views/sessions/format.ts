/** Display helpers for session rows. Pure and unit-testable. */

const SOURCE_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  copilot: 'Copilot',
  'copilot-cloud': 'Copilot Cloud',
  'copilot-agent': 'Copilot Agent',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

/** Compact token counts: 1.2k, 3.4M. Exact below 1,000. */
export function formatTokens(total: number): string {
  if (!Number.isFinite(total) || total <= 0) {
    return '0 tokens';
  }
  if (total < 1000) {
    return `${total} tokens`;
  }
  if (total < 1_000_000) {
    return `${trim(total / 1000)}k tokens`;
  }
  return `${trim(total / 1_000_000)}M tokens`;
}

/** Coarse duration: 45s, 12m, 1h 5m. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return '—';
  }
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/**
 * Relative time for list rows: "now", "14m", "3h", "yesterday", "12 Mar".
 * Recency is what the list sorts by, so it is what a row should show.
 */
export function formatRelative(epochMs: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return '';
  }
  const diff = nowMs - epochMs;
  if (diff < 60_000) {
    return 'now';
  }
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) {
    return `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 7) {
    return `${days}d`;
  }
  const date = new Date(epochMs);
  const sameYear = new Date(nowMs).getFullYear() === date.getFullYear();
  return date.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: sameYear ? undefined : 'numeric',
  });
}

/**
 * Split the data host's advisory status message into individual notes. The
 * host joins per-source notes with ' · ' (see `runIndex`), one note per source.
 */
export function splitNotes(message: string | undefined): string[] {
  if (message === undefined) {
    return [];
  }
  return message
    .split(' · ')
    .map((note) => note.trim())
    .filter((note) => note.length > 0);
}

/** One decimal place, without a trailing ".0". */
function trim(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
