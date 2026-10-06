import {
  attentionTier,
  finishedCandidates,
  liveCandidates,
  reconcile,
  type AttentionCandidate,
  type AttentionCompletion,
  type AttentionState,
  type FinishedFacts,
  type LiveFacts,
  type StoredAttention,
} from '@agent-observability/core/src/inbox/attention';
import type { InboxItem, InboxSnapshot, LiveBoardSnapshot, LiveSessionRow, RpcEvent, SessionRow } from '../../shared/rpc';
import { sessionKey } from '../../shared/rpc';
import type { IndexDb } from '../indexer/indexDb';
import type { InboxStore, TerminalFacts } from './inboxStore';

/**
 * The attention inbox: one cross-vendor list of what needs the developer now
 * and what finished since they last looked, most worrying first.
 *
 * It owns no detection of its own. Live reasons come from the live board's
 * rows; finished reasons from the index's rows (verdict, cost and, when the
 * completion check has run, its status). Core's `inbox/attention.ts` decides
 * what is a candidate, how candidates rank, and how the user's
 * seen/dismissed/snoozed state carries across recomputes; this service only
 * gathers the facts, persists the state and tells the renderer when the
 * visible list changed.
 *
 * One thing it must remember itself: how a session ENDED. The board stops
 * reading a transcript's tail once it has been quiet for half an hour and
 * reports `lastEvent: 'unknown'` from then on, so the last event seen while
 * the tail was still read is kept per session.
 */

/** Finished sessions considered per recompute; the inbox is not a history view. */
export const INBOX_FINISHED_LIMIT = 200;
/**
 * While sessions are live, look again this often. A tool call turns into a
 * probable approval prompt by staying quiet, which is exactly when the live
 * board has nothing new to announce.
 */
export const INBOX_RECHECK_MS = 30_000;
/** Remembered endings older than this are forgotten. */
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60_000;

export interface InboxTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface InboxServiceDeps {
  db: Pick<IndexDb, 'listSessions' | 'getRow'>;
  hidden: { all(): string[]; isHidden(source: string, sessionId: string): boolean };
  renames: { apply(rows: SessionRow[]): SessionRow[] };
  store: InboxStore;
  live: () => LiveBoardSnapshot;
  emit: (event: RpcEvent) => void;
  now?: () => number;
  timers?: InboxTimers;
}

const defaultTimers: InboxTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

type Reconciled = AttentionCandidate & { state: AttentionState; snoozedUntilMs?: number };

export class InboxService {
  private readonly now: () => number;
  private readonly timers: InboxTimers;
  private all: InboxItem[] = [];
  private fingerprint = '';
  private snoozeTimer: unknown;
  private recheckTimer: unknown;
  private computed = false;

  constructor(private readonly deps: InboxServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.timers = deps.timers ?? defaultTimers;
  }

  /** The live board changed: remember endings while they are still visible, then recompute. */
  onLive(snapshot: LiveBoardSnapshot): void {
    this.recompute(snapshot);
  }

  /** The index settled: verdicts, costs and completion statuses may have moved. */
  onIndexSettled(): void {
    this.recompute(this.deps.live());
  }

  snapshot(includeDismissed = false): InboxSnapshot {
    if (!this.computed) {
      this.recompute(this.deps.live());
    }
    return this.toSnapshot(includeDismissed);
  }

  mark(
    keys: readonly string[] | 'all',
    state: 'seen' | 'dismissed' | 'snoozed' | 'new',
    params: { untilMs?: number } = {},
  ): InboxSnapshot {
    if (!this.computed) {
      this.recompute(this.deps.live());
    }
    const now = this.now();
    const items = this.deps.store.items();
    const targets = keys === 'all' ? this.visible(false).map((item) => item.key) : keys;
    for (const key of targets) {
      const stored = items[key];
      if (stored === undefined) {
        continue;
      }
      if (state === 'seen') {
        // Seeing never undoes a dismiss or a snooze.
        if (stored.state === 'new') {
          items[key] = { ...stored, state: 'seen' };
        }
      } else if (state === 'snoozed') {
        const until = params.untilMs;
        if (typeof until === 'number' && Number.isFinite(until) && until > now) {
          items[key] = { ...stored, state: 'snoozed', snoozedUntilMs: until };
        }
      } else {
        const { snoozedUntilMs: _dropped, ...rest } = stored;
        void _dropped;
        items[key] = { ...rest, state };
      }
    }
    this.deps.store.save({ items, ...(keys === 'all' && state === 'seen' ? { lastVisitMs: now } : {}) });
    this.recompute(this.deps.live());
    return this.toSnapshot(false);
  }

  dispose(): void {
    if (this.snoozeTimer !== undefined) {
      this.timers.clearTimeout(this.snoozeTimer);
      this.snoozeTimer = undefined;
    }
    if (this.recheckTimer !== undefined) {
      this.timers.clearTimeout(this.recheckTimer);
      this.recheckTimer = undefined;
    }
  }

  // ── internals ──

  private recompute(board: LiveBoardSnapshot): void {
    const now = this.now();
    const store = this.deps.store;
    const liveRows = board.rows.filter((row) => !this.deps.hidden.isHidden(row.source, row.sessionId));

    // Remember each session's last readable event; forget stale ones.
    const terminals: Record<string, TerminalFacts> = {};
    for (const [key, facts] of Object.entries(store.terminals())) {
      if (now - facts.atMs < TERMINAL_RETENTION_MS) {
        terminals[key] = facts;
      }
    }
    for (const row of liveRows) {
      if (row.status !== 'finished' && row.lastEvent !== 'unknown') {
        terminals[sessionKey(row.source, row.sessionId)] = {
          event: row.lastEvent,
          failed: row.lastToolFailed === true,
          atMs: row.lastActivityMs,
        };
      }
    }

    const active = liveRows.filter((row) => row.status !== 'finished');
    const liveKeys = new Set(active.map((row) => sessionKey(row.source, row.sessionId)));
    const toFacts = (row: LiveSessionRow): LiveFacts => ({
      source: row.source,
      sessionId: row.sessionId,
      lastEvent: row.lastEvent,
      lastActivityMs: row.lastActivityMs,
      pendingTools: row.pendingTools,
      status: row.status,
      ...(row.lastToolFailed === true ? { lastToolFailed: true } : {}),
      ...(row.exactPermission === true ? { exactPermission: true } : {}),
    });
    const candidates: AttentionCandidate[] = [
      // A known permission request waits for the user however long ago it was asked.
      ...liveCandidates(active.filter((r) => r.exactPermission === true).map(toFacts), now, Number.MAX_SAFE_INTEGER),
      ...liveCandidates(active.filter((r) => r.exactPermission !== true).map(toFacts), now, board.finishedMs),
    ];

    const floor = store.createdAtMs;
    let finishedRows: SessionRow[] = [];
    try {
      finishedRows = this.deps.db
        .listSessions({ endedAfterMs: floor, limit: INBOX_FINISHED_LIMIT }, this.deps.hidden.all())
        .filter((row) => row.pending !== true && !liveKeys.has(sessionKey(row.source, row.sessionId)));
    } catch {
      finishedRows = [];
    }
    const medians = repositoryMedians(finishedRows);
    const finishedFacts: FinishedFacts[] = finishedRows.map((row) => {
      const terminal = terminals[sessionKey(row.source, row.sessionId)];
      const stats = medians.get(row.repository);
      const completion = (row as { completion?: AttentionCompletion }).completion;
      return {
        source: row.source,
        sessionId: row.sessionId,
        endedAtMs: row.endedAtMs,
        ...(row.verdict !== undefined ? { verdict: row.verdict } : {}),
        ...(completion !== undefined ? { completion } : {}),
        ...(row.costMicros !== undefined ? { costMicros: row.costMicros } : {}),
        ...(stats !== undefined ? { repositoryMedianCostMicros: stats.median, repositorySample: stats.sample } : {}),
        ...(terminal !== undefined ? { terminalEvent: terminal.event, lastToolFailed: terminal.failed } : {}),
      };
    });
    candidates.push(...finishedCandidates(finishedFacts, floor));

    const { items, next } = reconcile(store.items(), candidates, now);
    store.save({ items: next as Record<string, StoredAttention>, terminals });

    const rowsByKey = new Map(this.deps.renames.apply(finishedRows).map((row) => [sessionKey(row.source, row.sessionId), row]));
    const liveByKey = new Map(liveRows.map((row) => [sessionKey(row.source, row.sessionId), row]));
    this.all = items.map((item) => this.toItem(item, rowsByKey, liveByKey));
    this.computed = true;
    this.armSnooze(now);
    this.armRecheck(active.length > 0);

    const fingerprint = JSON.stringify(this.all.map((item) => [item.key, item.state, item.tier]));
    if (fingerprint !== this.fingerprint) {
      this.fingerprint = fingerprint;
      this.deps.emit({ event: 'inbox.changed', snapshot: this.toSnapshot(false) });
    }
  }

  private toItem(item: Reconciled, rows: Map<string, SessionRow>, live: Map<string, LiveSessionRow>): InboxItem {
    const key = sessionKey(item.source, item.sessionId);
    let row = rows.get(key);
    if (row === undefined) {
      const indexed = this.deps.db.getRow(item.source, item.sessionId);
      row = indexed === undefined ? undefined : this.deps.renames.apply([indexed])[0];
    }
    const liveRow = live.get(key);
    const title = row?.title ?? liveRow?.title;
    return {
      key: item.key,
      source: item.source,
      sessionId: item.sessionId,
      reason: item.reason,
      state: item.state,
      tier: attentionTier(item),
      flags: item.flags,
      exact: item.exact,
      repository: row?.repository ?? liveRow?.repository ?? 'unknown',
      ...(title !== undefined ? { title } : {}),
      sinceMs: item.episodeMs,
      pendingTools: item.pendingTools,
      ...(row?.verdict !== undefined ? { verdict: row.verdict } : {}),
      ...(row?.costMicros !== undefined ? { costMicros: row.costMicros } : {}),
      ...(item.snoozedUntilMs !== undefined ? { snoozedUntilMs: item.snoozedUntilMs } : {}),
    };
  }

  private visible(includeDismissed: boolean): InboxItem[] {
    const now = this.now();
    return includeDismissed
      ? this.all
      : this.all.filter(
          (item) =>
            item.state !== 'dismissed' &&
            !(item.state === 'snoozed' && item.snoozedUntilMs !== undefined && item.snoozedUntilMs > now),
        );
  }

  private toSnapshot(includeDismissed: boolean): InboxSnapshot {
    const items = this.visible(includeDismissed);
    return {
      items,
      unread: items.filter((item) => item.state === 'new').length,
      generatedAtMs: this.now(),
      lastVisitMs: this.deps.store.lastVisitMs,
    };
  }

  /** Time alone can create an item (a quiet tool call), so look again while anything is live. */
  private armRecheck(anyLive: boolean): void {
    if (this.recheckTimer !== undefined) {
      this.timers.clearTimeout(this.recheckTimer);
      this.recheckTimer = undefined;
    }
    if (anyLive) {
      this.recheckTimer = this.timers.setTimeout(() => {
        this.recheckTimer = undefined;
        this.recompute(this.deps.live());
      }, INBOX_RECHECK_MS);
    }
  }

  /** Wake when the nearest snooze runs out, so the item returns without waiting for other activity. */
  private armSnooze(now: number): void {
    if (this.snoozeTimer !== undefined) {
      this.timers.clearTimeout(this.snoozeTimer);
      this.snoozeTimer = undefined;
    }
    let nearest: number | undefined;
    for (const item of this.all) {
      if (item.state === 'snoozed' && item.snoozedUntilMs !== undefined && item.snoozedUntilMs > now) {
        nearest = nearest === undefined ? item.snoozedUntilMs : Math.min(nearest, item.snoozedUntilMs);
      }
    }
    if (nearest !== undefined) {
      this.snoozeTimer = this.timers.setTimeout(() => {
        this.snoozeTimer = undefined;
        this.recompute(this.deps.live());
      }, nearest - now + 1);
    }
  }
}

/** Median estimated cost per repository over the finished rows, for the cost-outlier flag. */
function repositoryMedians(rows: readonly SessionRow[]): Map<string, { median: number; sample: number }> {
  const byRepo = new Map<string, number[]>();
  for (const row of rows) {
    if (row.costMicros === undefined) {
      continue;
    }
    const list = byRepo.get(row.repository) ?? [];
    list.push(row.costMicros);
    byRepo.set(row.repository, list);
  }
  const medians = new Map<string, { median: number; sample: number }>();
  for (const [repository, costs] of byRepo) {
    costs.sort((a, b) => a - b);
    const mid = Math.floor(costs.length / 2);
    const median = costs.length % 2 === 1 ? costs[mid] : (costs[mid - 1] + costs[mid]) / 2;
    medians.set(repository, { median, sample: costs.length });
  }
  return medians;
}
