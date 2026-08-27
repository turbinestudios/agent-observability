import type * as vscode from 'vscode';
import { MAX_HISTORY, SyncRun, SyncStateStore } from '@agent-observability/core/src/sync/syncState';

/**
 * Durable {@link SyncStateStore} over {@link vscode.ExtensionContext.globalState}.
 * Per-user, survives restarts, and is not a synced workspace setting.
 *
 * Kept out of `syncState.ts` so that module — the contract plus its in-memory
 * implementation — carries no `vscode` reference at all and can live in the
 * shared core, where the desktop app backs the same seam with its own store.
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
