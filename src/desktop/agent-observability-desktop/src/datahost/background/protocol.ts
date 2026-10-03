import type { AnalysisStatus, IndexStatus } from '../../shared/rpc';

/** Only local configuration and index location cross this worker boundary. */
export interface BackgroundInput {
  indexPath: string;
  settings: Record<string, unknown>;
  copilotNotes: string[];
  /** Once per launch only; tests omit this to avoid touching real temp data. */
  cleanupSnapshots?: boolean;
  ensureArchiveIndexes?: boolean;
  /**
   * Set on passes the live board triggered: sessions that ended after this
   * instant are not re-analyzed yet, because their transcript is still moving.
   */
  skipAnalysisNewerThanMs?: number;
}

/** Rows are re-read/decorated by the broker; user annotations never go stale. */
export type BackgroundMessage =
  | { type: 'ready' }
  | { type: 'index'; status: IndexStatus }
  | { type: 'analysis'; status: AnalysisStatus }
  | { type: 'rows'; keys: string[] }
  | { type: 'removed'; keys: string[] }
  | { type: 'done' };

/** Small seam for deterministic scheduling/failure tests without real parsing. */
export interface BackgroundWorker {
  on(event: 'message', listener: (message: BackgroundMessage) => void): this;
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}