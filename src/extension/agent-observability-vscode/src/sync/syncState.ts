import type * as vscode from 'vscode';

/**
 * Durable sync state: a window watermark plus a bounded run history.
 *
 * The engine persists two things across VS Code restarts:
 *  - the WATERMARK: the exclusive UTC end (epoch ms) of the last successfully
 *    uploaded window, so the next run resumes from there. It is an OPTIMIZATION,
 *    not a correctness requirement — re-sending an overlapping window is safe
 *    because the server upserts by `rowKey`.
 *  - a RING BUFFER of the most recent {@link SyncRun} entries (capped) for the
 *    Sync view's history, most-recent-first when read.
 *
 * Abstracted behind {@link SyncStateStore} so tests use the in-memory impl and
 * the extension uses {@link GlobalStateSyncStateStore} over
 * `context.globalState`. No `vscode` value import — only a type import — so the
 * module loads headless under vitest.
 */

/** Discriminator of how a sync run finished (mirrors {@link SyncOutcome} kinds). */
export type SyncRunOutcome =
  | 'success'
  | 'blocked'
  | 'upToDate'
  | 'unauthorized'
  | 'rejected'
  | 'disabled'
  | 'serverError'
  | 'rateLimited'
  | 'network'
  | 'misconfigured';

/** One recorded sync attempt for the history view. Never contains secrets. */
export interface SyncRun {
  /** Epoch ms the run started. */
  startedAtMs: number;
  /** Inclusive UTC window start (epoch ms) the run covered. */
  windowStartMs: number;
  /** Exclusive UTC window end (epoch ms) the run covered. */
  windowEndMs: number;
  /** Buckets sent (0 for blocked/upToDate/failed-before-send). */
  bucketsSent: number;
  /** How the run finished. */
  outcome: SyncRunOutcome;
  /** Optional short, key-free explanation (e.g. a 400 detail). */
  message?: string;
}

/** Maximum number of {@link SyncRun} entries retained in the ring buffer. */
export const MAX_HISTORY = 20;

/** Persistence seam for the watermark + run history. */
export interface SyncStateStore {
  /** The last uploaded window end (epoch ms), or `undefined` when never synced. */
  getWatermarkMs(): number | undefined;
  /** Persist a new watermark (the exclusive end of a successfully sent window). */
  setWatermarkMs(value: number): Promise<void>;
  /**
   * Forget the watermark so the next run re-scans the full local window. Called
   * when the repository sync scope changes, so newly-included repositories
   * backfill from whatever local data remains. Re-sending is idempotent (the
   * server upserts by `rowKey`), and the local source DB is a short rolling
   * window, so the catch-up batch is naturally bounded.
   */
  clearWatermark(): Promise<void>;
  /** The run history, most-recent-first, capped at {@link MAX_HISTORY}. */
  getHistory(): SyncRun[];
  /** Append a run, evicting the oldest entry beyond {@link MAX_HISTORY}. */
  recordRun(run: SyncRun): Promise<void>;
}

/** In-memory {@link SyncStateStore} for tests (deterministic, no persistence). */
export class InMemorySyncStateStore implements SyncStateStore {
  private watermarkMs: number | undefined;
  /** Stored oldest-first internally; returned most-recent-first. */
  private history: SyncRun[] = [];

  constructor(initialWatermarkMs?: number) {
    this.watermarkMs = initialWatermarkMs;
  }

  getWatermarkMs(): number | undefined {
    return this.watermarkMs;
  }

  async setWatermarkMs(value: number): Promise<void> {
    this.watermarkMs = value;
  }

  async clearWatermark(): Promise<void> {
    this.watermarkMs = undefined;
  }

  getHistory(): SyncRun[] {
    return [...this.history].reverse();
  }

  async recordRun(run: SyncRun): Promise<void> {
    this.history.push(run);
    if (this.history.length > MAX_HISTORY) {
      this.history.splice(0, this.history.length - MAX_HISTORY);
    }
  }
}

/**
 * Durable {@link SyncStateStore} over {@link vscode.ExtensionContext.globalState}.
 * Per-user, survives restarts, and is not a synced workspace setting.
 */
export class GlobalStateSyncStateStore implements SyncStateStore {
  /** globalState key for the window watermark (exclusive end, epoch ms). */
  static readonly WATERMARK_KEY = 'agentObservability.sync.lastWindowEndMs';
  /** globalState key for the run-history ring buffer (stored oldest-first). */
  static readonly HISTORY_KEY = 'agentObservability.sync.runHistory';

  constructor(private readonly globalState: vscode.Memento) {}

  getWatermarkMs(): number | undefined {
    const value = this.globalState.get<number>(GlobalStateSyncStateStore.WATERMARK_KEY);
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }

  async setWatermarkMs(value: number): Promise<void> {
    await this.globalState.update(GlobalStateSyncStateStore.WATERMARK_KEY, value);
  }

  async clearWatermark(): Promise<void> {
    // Setting to undefined removes the key from globalState; getWatermarkMs then
    // reports `undefined` and the next run starts from the earliest local row.
    await this.globalState.update(GlobalStateSyncStateStore.WATERMARK_KEY, undefined);
  }

  getHistory(): SyncRun[] {
    const raw = this.globalState.get<SyncRun[]>(GlobalStateSyncStateStore.HISTORY_KEY, []);
    return Array.isArray(raw) ? [...raw].reverse() : [];
  }

  async recordRun(run: SyncRun): Promise<void> {
    const stored = this.globalState.get<SyncRun[]>(GlobalStateSyncStateStore.HISTORY_KEY, []);
    const next = Array.isArray(stored) ? [...stored, run] : [run];
    if (next.length > MAX_HISTORY) {
      next.splice(0, next.length - MAX_HISTORY);
    }
    await this.globalState.update(GlobalStateSyncStateStore.HISTORY_KEY, next);
  }
}
