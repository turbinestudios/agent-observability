import type { SessionVerdict } from '../analysis/retrospective';
import { LIVE_FINISHED_MS, PENDING_TOOL_HINT_MS, type LiveLastEvent, type LiveStatus } from '../live/liveStatus';

/**
 * The attention inbox: what needs the developer NOW, and what finished since
 * they last looked, most worrying first.
 *
 * Pure. Candidates are derived from facts the caller already holds (live-board
 * rows, indexed sessions); {@link reconcile} merges them with the stored
 * per-item state. Nothing here reads a transcript, and nothing here is
 * content: keys, enums, timestamps and tool names only.
 *
 * Two deliberate choices:
 * - "Waiting" keys off the transcript's LAST EVENT, not the live status. The
 *   board turns a waiting session "idle" after three minutes; the inbox must
 *   keep saying it is waiting for the user until the agent resumes.
 * - A pending tool call is only "may be waiting for approval" after a delay,
 *   and never for sub-agent calls, whose main thread is legitimately quiet.
 *   It is a guess and is ranked below an exact permission request.
 */

export type AttentionReason =
  | 'permission'
  | 'permission-likely'
  | 'waiting'
  | 'finished'
  | 'ended-error'
  | 'ended-interrupted';
export type AttentionState = 'new' | 'seen' | 'dismissed' | 'snoozed';
export type AttentionFlag = 'contradicted' | 'unverified' | 'incomplete' | 'struggled' | 'abandoned' | 'cost-outlier';

/** Mirrors the completion check's status; local so this module has no dependency on it. */
export type AttentionCompletion = 'verified' | 'unverified' | 'contradicted' | 'incomplete' | 'not-applicable';

/** Shell-like tools legitimately run long; they get this much before the hint. */
export const PERMISSION_HINT_SLOW_TOOL_MS = 5 * 60_000;
/** Sub-agent tools: a pending call is work in progress, never an approval prompt. */
export const PERMISSION_HINT_EXCLUDED_TOOLS: readonly string[] = ['Task', 'Agent'];
export const PERMISSION_HINT_SHELL_TOOLS: readonly string[] = ['Bash', 'PowerShell', 'shell', 'run_in_terminal'];
/** Finished items are forgotten after a week. */
export const INBOX_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const INBOX_MAX_ITEMS = 500;
/** A repository needs this many priced sessions before a cost is called an outlier. */
export const COST_OUTLIER_MIN_SAMPLE = 10;
/** Cost at or above this multiple of the repository median is an outlier. */
export const COST_OUTLIER_MULTIPLE = 3;

/** Lower sorts first. Finished-family items take the best tier among their reason and flags. */
export const ATTENTION_TIER: Readonly<Record<string, number>> = {
  permission: 0,
  'permission-likely': 1,
  waiting: 2,
  contradicted: 3,
  'ended-error': 4,
  unverified: 5,
  incomplete: 5,
  struggled: 6,
  abandoned: 6,
  'ended-interrupted': 7,
  'cost-outlier': 8,
  finished: 9,
};

export interface LiveFacts {
  source: string;
  sessionId: string;
  lastEvent: LiveLastEvent;
  lastActivityMs: number;
  pendingTools: string[];
  status: LiveStatus;
  lastToolFailed?: boolean;
  /** Set only by a host that sees the real permission request (the Run view). */
  exactPermission?: boolean;
}

export interface FinishedFacts {
  source: string;
  sessionId: string;
  endedAtMs: number;
  verdict?: SessionVerdict;
  completion?: AttentionCompletion;
  costMicros?: number;
  repositoryMedianCostMicros?: number;
  repositorySample?: number;
  /** How the transcript ended, remembered while the board still read its tail. */
  terminalEvent?: LiveLastEvent;
  lastToolFailed?: boolean;
}

export interface AttentionCandidate {
  key: string;
  source: string;
  sessionId: string;
  reason: AttentionReason;
  /** When this occurrence began; a newer episode resets a dismissed item. */
  episodeMs: number;
  /** False when the reason is inferred rather than observed. */
  exact: boolean;
  flags: AttentionFlag[];
  pendingTools: string[];
}

export interface StoredAttention {
  state: AttentionState;
  episodeMs: number;
  firstSeenMs: number;
  snoozedUntilMs?: number;
  terminalEvent?: LiveLastEvent;
}

const LIVE_REASONS: ReadonlySet<string> = new Set<AttentionReason>(['permission', 'permission-likely', 'waiting']);
const WAITING_EVENTS: ReadonlySet<LiveLastEvent> = new Set<LiveLastEvent>([
  'assistant-text',
  'turn-ended',
  'interruption',
]);

export function attentionKey(source: string, sessionId: string, reason: AttentionReason): string {
  return `${source}:${sessionId}|${reason}`;
}

function reasonOfKey(key: string): string {
  const at = key.lastIndexOf('|');
  return at < 0 ? '' : key.slice(at + 1);
}

function inList(list: readonly string[], tool: string): boolean {
  const lower = tool.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === lower);
}

/**
 * What needs the user among sessions still on the board. At most one
 * candidate per session; sessions quiet for `finishedMs` or longer are left to
 * {@link finishedCandidates}.
 */
export function liveCandidates(
  rows: readonly LiveFacts[],
  nowMs: number,
  finishedMs: number = LIVE_FINISHED_MS,
): AttentionCandidate[] {
  const candidates: AttentionCandidate[] = [];
  for (const row of rows) {
    const age = nowMs - row.lastActivityMs;
    if (age >= finishedMs) {
      continue;
    }
    let reason: AttentionReason | undefined;
    let exact = true;
    if (row.exactPermission === true) {
      reason = 'permission';
    } else if (row.lastEvent === 'tool-pending') {
      const excluded = row.pendingTools.some((tool) => inList(PERMISSION_HINT_EXCLUDED_TOOLS, tool));
      const slow = row.pendingTools.some((tool) => inList(PERMISSION_HINT_SHELL_TOOLS, tool));
      const threshold = slow ? PERMISSION_HINT_SLOW_TOOL_MS : PENDING_TOOL_HINT_MS;
      if (!excluded && age >= threshold) {
        reason = 'permission-likely';
        exact = false;
      }
    } else if (WAITING_EVENTS.has(row.lastEvent)) {
      reason = 'waiting';
    }
    if (reason === undefined) {
      continue;
    }
    candidates.push({
      key: attentionKey(row.source, row.sessionId, reason),
      source: row.source,
      sessionId: row.sessionId,
      reason,
      episodeMs: row.lastActivityMs,
      exact,
      flags: [],
      pendingTools: reason === 'waiting' ? [] : [...row.pendingTools],
    });
  }
  return candidates;
}

export function isCostOutlier(
  cost: number | undefined,
  median: number | undefined,
  sample: number | undefined,
): boolean {
  if (cost === undefined || median === undefined || sample === undefined) {
    return false;
  }
  return sample >= COST_OUTLIER_MIN_SAMPLE && median > 0 && cost >= COST_OUTLIER_MULTIPLE * median;
}

/**
 * One item per session that ended at or after `floorMs`. The caller passes
 * only sessions that are no longer live on the board.
 */
export function finishedCandidates(rows: readonly FinishedFacts[], floorMs: number): AttentionCandidate[] {
  const candidates: AttentionCandidate[] = [];
  for (const row of rows) {
    if (row.endedAtMs < floorMs) {
      continue;
    }
    let reason: AttentionReason = 'finished';
    if (row.lastToolFailed === true) {
      reason = 'ended-error';
    } else if (row.terminalEvent === 'interruption' || row.terminalEvent === 'tool-pending') {
      reason = 'ended-interrupted';
    }
    const flags: AttentionFlag[] = [];
    if (row.completion === 'contradicted' || row.completion === 'unverified' || row.completion === 'incomplete') {
      flags.push(row.completion);
    }
    if (row.verdict === 'struggled' || row.verdict === 'abandoned') {
      flags.push(row.verdict);
    }
    if (isCostOutlier(row.costMicros, row.repositoryMedianCostMicros, row.repositorySample)) {
      flags.push('cost-outlier');
    }
    candidates.push({
      key: attentionKey(row.source, row.sessionId, reason),
      source: row.source,
      sessionId: row.sessionId,
      reason,
      episodeMs: row.endedAtMs,
      exact: false,
      flags,
      pendingTools: [],
    });
  }
  return candidates;
}

export function attentionTier(candidate: AttentionCandidate): number {
  let tier = ATTENTION_TIER[candidate.reason] ?? ATTENTION_TIER.finished;
  if (!LIVE_REASONS.has(candidate.reason)) {
    for (const flag of candidate.flags) {
      tier = Math.min(tier, ATTENTION_TIER[flag] ?? tier);
    }
  }
  return tier;
}

/**
 * Most worrying first. Within a live tier the session blocked longest leads;
 * within a finished tier the most recent does; the key breaks any tie so the
 * order never flaps.
 */
export function compareAttention(a: AttentionCandidate, b: AttentionCandidate): number {
  const tier = attentionTier(a) - attentionTier(b);
  if (tier !== 0) {
    return tier;
  }
  if (a.episodeMs !== b.episodeMs) {
    return LIVE_REASONS.has(a.reason) ? a.episodeMs - b.episodeMs : b.episodeMs - a.episodeMs;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Merge this moment's candidates with the stored state.
 *
 * - An unknown candidate is `new`; so is one whose episode is newer than the
 *   stored one (a dismissed "waiting" comes back on the next wait) and a
 *   snoozed one whose snooze has run out.
 * - A live-reason record with no candidate is forgotten: the condition cleared.
 * - Finished-family records are kept for {@link INBOX_RETENTION_MS} so a
 *   dismissed item stays dismissed, then pruned, oldest first, down to
 *   {@link INBOX_MAX_ITEMS}.
 */
export function reconcile(
  stored: Readonly<Record<string, StoredAttention>>,
  candidates: readonly AttentionCandidate[],
  nowMs: number,
): {
  items: (AttentionCandidate & { state: AttentionState; snoozedUntilMs?: number })[];
  next: Record<string, StoredAttention>;
} {
  const next: Record<string, StoredAttention> = {};
  const items: (AttentionCandidate & { state: AttentionState; snoozedUntilMs?: number })[] = [];
  const current = new Set<string>();

  for (const candidate of candidates) {
    if (current.has(candidate.key)) {
      continue;
    }
    current.add(candidate.key);
    const previous = stored[candidate.key];
    let record: StoredAttention;
    if (previous === undefined || candidate.episodeMs > previous.episodeMs) {
      record = { state: 'new', episodeMs: candidate.episodeMs, firstSeenMs: nowMs };
    } else if (
      previous.state === 'snoozed' &&
      (previous.snoozedUntilMs === undefined || previous.snoozedUntilMs <= nowMs)
    ) {
      record = { state: 'new', episodeMs: previous.episodeMs, firstSeenMs: previous.firstSeenMs };
    } else {
      record = { ...previous };
    }
    if (previous?.terminalEvent !== undefined && record.terminalEvent === undefined) {
      record.terminalEvent = previous.terminalEvent;
    }
    next[candidate.key] = record;
    items.push({
      ...candidate,
      state: record.state,
      ...(record.state === 'snoozed' && record.snoozedUntilMs !== undefined
        ? { snoozedUntilMs: record.snoozedUntilMs }
        : {}),
    });
  }

  for (const [key, record] of Object.entries(stored)) {
    if (current.has(key) || LIVE_REASONS.has(reasonOfKey(key))) {
      continue;
    }
    if (nowMs - record.episodeMs < INBOX_RETENTION_MS) {
      next[key] = { ...record };
    }
  }

  const finishedKeys = Object.keys(next).filter((key) => !LIVE_REASONS.has(reasonOfKey(key)));
  if (finishedKeys.length > INBOX_MAX_ITEMS) {
    // Records without a current candidate go first, then the oldest.
    finishedKeys.sort((a, b) => {
      const held = Number(current.has(a)) - Number(current.has(b));
      if (held !== 0) {
        return held;
      }
      const age = next[a].episodeMs - next[b].episodeMs;
      return age !== 0 ? age : a < b ? -1 : a > b ? 1 : 0;
    });
    for (const key of finishedKeys.slice(0, finishedKeys.length - INBOX_MAX_ITEMS)) {
      delete next[key];
    }
  }

  items.sort(compareAttention);
  return { items, next };
}

export function unreadCount(items: readonly { state: AttentionState }[]): number {
  return items.reduce((count, item) => count + (item.state === 'new' ? 1 : 0), 0);
}
