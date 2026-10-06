/** Display helpers for session rows. Pure and unit-testable. */

const SOURCE_LABELS: Record<string, string> = {
  claude: 'Claude Code',
  copilot: 'Copilot',
  'copilot-cli': 'Copilot CLI',
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
 * Micro-USD as compact dollars: `$0.42`, `<$0.01`, `$1,234`. Empty for an
 * absent or invalid value — an unpriced session is UNKNOWN cost, not free, so
 * a row simply says nothing rather than claiming a number.
 */
export function formatCost(micros: number | undefined | null): string {
  if (micros === undefined || micros === null || !Number.isFinite(micros) || micros < 0) {
    return '';
  }
  const usd = micros / 1_000_000;
  if (usd === 0) {
    return '$0.00';
  }
  if (usd < 0.01) {
    return '<$0.01';
  }
  if (usd < 1000) {
    return `$${usd.toFixed(2)}`;
  }
  // Fixed comma grouping, not toLocaleString: the dollar figure should render
  // the same on every machine locale.
  return `$${String(Math.round(usd)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;
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
 * `owner/repo` — the part that identifies a repository, without the host
 * boilerplate. Shared by the Dashboard's bars and the list's filter chips, so
 * clicking a bar and reading the resulting chip name the same thing.
 */
export function shortRepo(repository: string): string {
  const parts = repository
    .replace(/\.git$/, '')
    .split('/')
    .filter((p) => p.length > 0);
  return parts.slice(-2).join('/') || repository;
}

/**
 * A date as `<input type="date">` wants it, `YYYY-MM-DD`, in LOCAL time —
 * matching the day boundaries the overview groups by. `toISOString` would shift
 * the day for anyone east or west of UTC.
 */
export function toDateInput(epochMs: number): string {
  const date = new Date(epochMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The reverse: a `YYYY-MM-DD` from a date input as a local timestamp. `edge`
 * picks which end of that day — a range is inclusive, so "to 7 Aug" has to mean
 * the last instant of the 7th, not its first.
 */
export function fromDateInput(value: string, edge: 'start' | 'end'): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }
  if (edge === 'end') {
    date.setHours(23, 59, 59, 999);
  }
  return date.getTime();
}

/** A date for a filter chip: "7 Aug", or "7 Aug 2025" outside this year. */
export function formatDay(epochMs: number, nowMs: number = Date.now()): string {
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
