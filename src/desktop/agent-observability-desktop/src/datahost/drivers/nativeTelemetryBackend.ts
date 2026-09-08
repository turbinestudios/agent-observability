import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { TelemetryDatabase } from '@agent-observability/core/src/telemetry/database';
import type {
  ReadonlySqliteConnection,
  TelemetryReadBackend,
  TelemetryReadHandle,
} from '@agent-observability/core/src/telemetry/readBackend';
import type { SessionTitleInfo } from '@agent-observability/core/src/telemetry/sessionTitles';
import { overlayTitle } from '@agent-observability/core/src/telemetry/titleStore';
import type { IndexDb } from '../indexer/indexDb';

/**
 * Read Copilot telemetry in place, never copying the archive or replaying WAL.
 * Every request gets read-only SQLite transactions and fresh shared-query
 * wrappers. Connections close before returning to the event loop, so neither
 * stale per-snapshot caches nor idle WAL readers accumulate between requests.
 * The shared query/schema/sanitization logic remains exactly the same as the
 * extension's snapshot reader. No source migration/index creation happens here.
 */
export class NativeTelemetryBackend implements TelemetryReadBackend {
  constructor(private readonly index: Pick<IndexDb, 'allTitles'>) {}

  read<T>(targets: readonly { path: string }[], run: (handles: TelemetryReadHandle[]) => T): T {
    const handles: TelemetryReadHandle[] = [];
    let firstError: unknown;
    try {
      for (const target of targets) {
        let native: Database.Database | undefined;
        try {
          // Preserve ENOENT/EACCES classification rather than flattening all
          // missing/denied sources into SQLite's generic CANTOPEN result.
          fs.accessSync(target.path, fs.constants.R_OK);
          native = new Database(target.path, { readonly: true, fileMustExist: true });
          const connection = native;
          connection.exec('BEGIN');
          const reader: ReadonlySqliteConnection = {
            get: (sql, params) => connection.prepare(sql).get(...(params ?? [])),
            all: (sql, params) => connection.prepare(sql).all(...(params ?? [])),
            close: () => {
              if (!connection.open) {
                return;
              }
              try {
                if (connection.inTransaction) {
                  connection.exec('ROLLBACK');
                }
              } finally {
                connection.close();
              }
            },
          };
          // Schema validation pins this transaction's snapshot on the first
          // SELECT. Failure closes it too; another source may still succeed.
          const db = TelemetryDatabase.fromConnection(reader);
          handles.push({ db, sourcePath: target.path });
        } catch (err) {
          if (native?.open) {
            native.close();
          }
          firstError ??= err;
        }
      }
      if (handles.length === 0) {
        throw firstError ?? Object.assign(new Error('Copilot telemetry database not found.'), { code: 'ENOENT' });
      }
      return run(handles);
    } finally {
      for (const handle of handles) {
        handle.db.close();
      }
    }
  }

  readTitles(handle: TelemetryReadHandle): Map<string, SessionTitleInfo> {
    // The archive preserves names after VS Code rotates its title stores.
    // Current indexed titles overlay it with core's authority rule: a derived
    // first-prompt fallback must not displace an authoritative archived title.
    const titles = handle.db.readArchivedSessionTitles();
    for (const [id, info] of this.index.allTitles()) {
      overlayTitle(titles, id, info);
    }
    return titles;
  }
}