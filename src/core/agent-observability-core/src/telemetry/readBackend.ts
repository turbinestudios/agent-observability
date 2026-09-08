import type { TelemetryDatabase } from './database';
import type { SessionTitleInfo } from './sessionTitles';

/** Driver-neutral positional values used by the shared telemetry queries. */
export type ReadBindings = Array<string | number | bigint | Uint8Array | null>;

/**
 * Minimal connection for the shared query layer. Hosts enforce read-only mode
 * when opening it; this interface deliberately exposes no write or DDL API.
 * Results may use null (WASM) or undefined (native) for a missing single row.
 */
export interface ReadonlySqliteConnection {
  get(sql: string, params?: ReadBindings): unknown;
  all(sql: string, params?: ReadBindings): unknown[];
  close(): void;
}

/** One consistent source view. Caches belong to this view, never a live file. */
export interface TelemetryReadHandle {
  db: TelemetryDatabase;
  sourcePath: string;
  titles?: Map<string, SessionTitleInfo>;
  chatSessionIds?: Map<string, string>;
}

/**
 * Optional host-owned alternative to core's persisted WASM snapshot handles.
 * The host pins a consistent read view for the SYNCHRONOUS callback, validates
 * each connection with TelemetryDatabase.fromConnection, skips unavailable
 * sources when others work, and releases EVERY handle in finally. Handles and
 * their derived caches must not outlive the callback or hold WAL readers idle.
 * No native dependency or host API belongs in core.
 */
export interface TelemetryReadBackend {
  read<T>(targets: readonly { path: string }[], run: (handles: TelemetryReadHandle[]) => T): T;
  /** Local title overlay; replaces workspace-store scanning for this host. */
  readTitles(handle: TelemetryReadHandle): Map<string, SessionTitleInfo>;
}