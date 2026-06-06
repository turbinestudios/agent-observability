import { Configuration } from '../config/configuration';
import { resolveDatabasePath, PathConfig } from './paths';
import { createReadonlySnapshot, ReadonlySnapshot, sourceMtime } from './snapshot';
import { TelemetryDatabase, SchemaMismatchError } from './database';
import { AggregationRow } from '../aggregate/aggregator';
import {
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionSummary,
  SessionDetail,
} from './models';

/**
 * High-level facade the view providers depend on.
 *
 * Responsibilities:
 * - Honor the `agentObservability.localTelemetry.enabled` feature flag.
 * - Resolve the DB path, snapshot it read-only, open + validate, and manage
 *   the snapshot + connection lifecycle (re-snapshot on refresh, skip when the
 *   source mtime is unchanged).
 * - Classify failures into a small typed {@link Result} the views render as a
 *   single explanatory row — never throwing into the tree UI.
 *
 * Phase 3 reuses {@link getSessionInteractions}; Phase 5 reuses the underlying
 * queries for aggregation.
 */

/** Failure reasons surfaced to the UI. */
export type FailureReason =
  | 'disabled'
  | 'missingDb'
  | 'permission'
  | 'schemaMismatch'
  | 'error';

/** Discriminated result the views consume without try/catch. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: FailureReason; message: string };

/** Minimal config surface the service needs (satisfied by {@link Configuration}). */
export interface ServiceConfig extends PathConfig {
  isLocalTelemetryEnabled(): boolean;
}

interface CacheEntry {
  overview?: OverviewMetrics;
  repositories?: RepositorySummary[];
  /** Cache key: `${repository ?? '*'}::${limit ?? '*'}`. */
  sessions: Map<string, SessionSummary[]>;
}

/** A live, opened snapshot + its source mtime, kept between queries. */
interface OpenHandle {
  snapshot: ReadonlySnapshot;
  db: TelemetryDatabase;
  /** Source DB path the snapshot was taken from. */
  sourcePath: string;
}

export class TelemetryService {
  private readonly config: ServiceConfig;
  private handle: OpenHandle | undefined;
  private cache: CacheEntry = { sessions: new Map() };

  constructor(config: ServiceConfig | Configuration) {
    this.config = config;
  }

  /**
   * Drop the cached snapshot, connection and query cache. Called on refresh and
   * on dispose. Re-acquisition happens lazily on the next query.
   */
  refresh(): void {
    this.disposeHandle();
    this.cache = { sessions: new Map() };
  }

  /** Tear down the snapshot + connection. Call from extension deactivate(). */
  dispose(): void {
    this.disposeHandle();
  }

  /** Overview metrics. */
  getOverview(sinceMs?: number): Result<OverviewMetrics> {
    return this.withDatabase((db) => {
      if (sinceMs === undefined && this.cache.overview !== undefined) {
        return this.cache.overview;
      }
      const value = db.getOverviewMetrics(sinceMs);
      if (sinceMs === undefined) {
        this.cache.overview = value;
      }
      return value;
    });
  }

  /** Repository summaries (two-level Sessions tree roots). */
  listRepositories(): Result<RepositorySummary[]> {
    return this.withDatabase((db) => {
      if (this.cache.repositories !== undefined) {
        return this.cache.repositories;
      }
      const value = db.listRepositories();
      this.cache.repositories = value;
      return value;
    });
  }

  /** Session summaries, optionally filtered to a repository. */
  listSessions(repository?: string, limit?: number): Result<SessionSummary[]> {
    return this.withDatabase((db) => {
      const key = `${repository ?? '*'}::${limit ?? '*'}`;
      const cached = this.cache.sessions.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const value = db.listSessions(repository, limit);
      this.cache.sessions.set(key, value);
      return value;
    });
  }

  /** Ordered interactions for a session (Phase 3 detail). Not cached. */
  getSessionInteractions(sessionKey: string): Result<Interaction[]> {
    return this.withDatabase((db) => db.getSessionInteractions(sessionKey));
  }

  /**
   * LOCAL-ONLY raw span-attribute values for a session, keyed by span id, for the
   * given content-predicate attribute. Used exclusively by the local
   * workflow-deviation path to evaluate a
   * {@link ../deviation/models.ContentPredicate} on-machine; the values are never
   * cached, logged, or uploaded, and never reach the aggregate/sync path.
   */
  getSpanAttributes(sessionKey: string, attributeKey: string): Result<Map<string, string>> {
    return this.withDatabase((db) => db.getAttributesBySpan(sessionKey, attributeKey));
  }

  /**
   * Safe per-span aggregation rows for the Phase 5 cloud aggregate engine,
   * optionally bounded to `[sinceMs, untilMs)` on span start time. Carries ONLY
   * non-sensitive metadata (sanitized repository, mapped mode/tool, counts,
   * tokens); never any raw-content attribute. Not cached — aggregation is an
   * on-demand operation (preview / scheduled sync).
   */
  getAggregationRows(sinceMs?: number, untilMs?: number): Result<AggregationRow[]> {
    return this.withDatabase((db) => db.getAggregationRows(sinceMs, untilMs));
  }

  /**
   * Full session drill-down for the LOCAL detail panel: summary header plus a
   * chronological timeline that MAY carry local-only raw content
   * (`userRequest`). Not cached. The detail panel renders the result locally
   * (HTML-escaped); the content never crosses any networked path.
   *
   * Returns a `missingDb`-classified failure shape when the session is absent
   * (no spans) so the panel can render a single explanatory message.
   */
  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    return this.withDatabase((db) => {
      const detail = db.getSessionDetail(sessionKey);
      if (detail === undefined) {
        throw sessionNotFoundError(sessionKey);
      }
      return detail;
    });
  }

  /**
   * Acquire (or reuse) an open database and run `fn`, mapping any failure to a
   * typed {@link Result}. This is the single place that opens the DB and
   * classifies errors, so every public method stays a one-liner.
   */
  private withDatabase<T>(fn: (db: TelemetryDatabase) => T): Result<T> {
    if (!this.config.isLocalTelemetryEnabled()) {
      return {
        ok: false,
        reason: 'disabled',
        message: 'Local telemetry is disabled.',
      };
    }

    let db: TelemetryDatabase;
    try {
      db = this.ensureOpen();
    } catch (err) {
      return this.classify(err);
    }

    try {
      return { ok: true, value: fn(db) };
    } catch (err) {
      // A query-time failure (e.g. connection went away). Drop the handle so a
      // later refresh re-snapshots cleanly, then classify.
      this.disposeHandle();
      return this.classify(err);
    }
  }

  /**
   * Ensure an open, schema-valid database handle, re-snapshotting only when the
   * source mtime has changed since the last snapshot (or there is no handle).
   *
   * @throws a typed error the caller classifies: a `{ code: 'ENOENT' }`-shaped
   *   error for a missing DB, the native EACCES/EPERM error, or
   *   {@link SchemaMismatchError}.
   */
  private ensureOpen(): TelemetryDatabase {
    const resolved = resolveDatabasePath(this.config);
    if (resolved.path === undefined || !resolved.exists) {
      throw missingDbError(resolved.path);
    }
    const sourcePath = resolved.path;

    // Reuse the open handle when the source is unchanged.
    if (this.handle !== undefined && this.handle.sourcePath === sourcePath) {
      const current = sourceMtime(sourcePath);
      if (current !== undefined && current === this.handle.snapshot.sourceMtimeMs) {
        return this.handle.db;
      }
      // Source changed (or vanished) — drop the stale handle and re-snapshot.
      this.disposeHandle();
    } else if (this.handle !== undefined) {
      this.disposeHandle();
    }

    const snapshot = createReadonlySnapshot(sourcePath);
    let db: TelemetryDatabase;
    try {
      db = TelemetryDatabase.open(snapshot.dbPath);
    } catch (err) {
      snapshot.dispose();
      throw err;
    }
    this.handle = { snapshot, db, sourcePath };
    // A fresh snapshot invalidates the query cache.
    this.cache = { sessions: new Map() };
    return db;
  }

  private disposeHandle(): void {
    if (this.handle === undefined) {
      return;
    }
    const { snapshot, db } = this.handle;
    this.handle = undefined;
    db.close();
    snapshot.dispose();
  }

  /** Map a thrown error to a typed failure {@link Result}. */
  private classify(err: unknown): Result<never> {
    if (err instanceof SchemaMismatchError) {
      return {
        ok: false,
        reason: 'schemaMismatch',
        message: err.message,
      };
    }
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: 'missingDb',
        message: 'Copilot telemetry database not found.',
      };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        reason: 'permission',
        message: 'Permission denied reading the Copilot telemetry database.',
      };
    }
    // better-sqlite3 throws a SqliteError for a non-DB / corrupt file; treat a
    // failure to read a present-but-invalid file as a schema mismatch rather
    // than an opaque crash.
    const message = err instanceof Error ? err.message : String(err);
    if (/not a database|file is not a database|malformed|disk image is malformed/i.test(message)) {
      return {
        ok: false,
        reason: 'schemaMismatch',
        message: 'Telemetry database is not a recognized SQLite database.',
      };
    }
    return { ok: false, reason: 'error', message };
  }
}

/** Build an ENOENT-shaped error so the classifier maps a missing session. */
function sessionNotFoundError(sessionKey: string): NodeJS.ErrnoException {
  const err = new Error(`No interactions found for session ${sessionKey}.`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/** Build an ENOENT-shaped error so the classifier maps it to `missingDb`. */
function missingDbError(attemptedPath: string | undefined): NodeJS.ErrnoException {
  const err = new Error(
    attemptedPath !== undefined
      ? `Copilot telemetry database not found at ${attemptedPath}.`
      : 'Could not determine the Copilot telemetry database location.',
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}
