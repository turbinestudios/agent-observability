import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { Database } from 'node-sqlite3-wasm';
import { IngestStore, SPAN_COLUMNS } from './ingestStore';
import { AttrRow, SpanRow, SpanRows } from './otlpToRows';
import { createReadonlySnapshot, ReadonlySnapshot, sourceMtime } from '../telemetry/snapshot';
import { resolveDatabasePaths, PathConfig, PathEnvironment } from '../telemetry/paths';
import { WriterLease } from './writerLease';

/**
 * Continuously copies Copilot spans from the short-lived native `agent-traces.db`
 * (all discovered editions/environments) — plus the extension's own live-OTLP
 * ingest DB when present — into the DURABLE, home-anchored archive
 * ({@link ./archivePaths}), so Copilot sessions persist and show up in every VS
 * Code window, the way Claude Code sessions already do.
 *
 * Each sweep:
 *   1. discovers every native source ({@link ../telemetry/paths.resolveDatabasePaths}),
 *   2. skips a source whose mtime is unchanged since the last sweep,
 *   3. snapshots it ({@link ../telemetry/snapshot.createReadonlySnapshot}, which
 *      handles Copilot's WAL), reads spans newer than the per-source watermark,
 *   4. upserts them into the archive (idempotent by `span_id`) and advances the
 *      watermark to `max(end_time_ms) - GRACE_MS` so boundary spans are re-read
 *      next time without being double-counted.
 *
 * Only ONE instance across all windows writes the shared archive — the
 * {@link ./writerLease.WriterLease} elects it; the others stay pure readers (the
 * read layer always reads a private snapshot copy, so reading is always safe).
 *
 * Vscode-free: the extension supplies the paths, config, retention, signal, and
 * (optionally) a snapshot factory + clock for headless tests.
 */

/** Re-read spans within this window of the watermark so boundary spans aren't lost. */
const GRACE_MS = 5_000;
/** Chunk size for the `span_id IN (...)` attribute fetch (bounded placeholder count). */
const ATTR_CHUNK_SIZE = 500;

/** Injectable snapshot factory (defaults to the real WAL-safe snapshot). */
export type SnapshotFactory = (dbPath: string) => ReadonlySnapshot;

export interface CopilotArchiverDeps {
  /** Absolute path to the durable, home-anchored archive DB. */
  archiveDbPath: string;
  /**
   * Config seam resolving the native Copilot DB(s) to sweep (its
   * `getSqlitePathOverride` is honored — a fixture points this at a fake DB).
   */
  config: PathConfig;
  /** Optional host seam for path resolution (tests inject a fake). */
  environment?: PathEnvironment;
  /**
   * The extension's own live-OTLP ingest DB, swept too when it exists. When live
   * updates are on, Copilot exports to the receiver (not its native DB), so this
   * is where recent spans land — folding it into the archive keeps history whole.
   */
  liveIngestDbPath?: string;
  /** Prune archive spans older than this (ms). */
  retentionMs: number;
  /** Interval between sweeps (ms) — also drives the writer-lease heartbeat. */
  sweepIntervalMs: number;
  /** Fired once per sweep that wrote new rows — wire to `controller.signal`. */
  signal: () => void;
  /** Runtime errors (snapshot/read/write). Log only; never user-facing. */
  onError?: (err: unknown) => void;
  /** Injectable clock (tests). */
  now?: () => number;
  /** Injectable snapshot factory (tests). */
  snapshotFactory?: SnapshotFactory;
}

/** Basename of the writer-lease lock beside the archive DB. */
const WRITER_LOCK_BASENAME = 'writer.lock';

export class CopilotArchiver {
  private store: IngestStore | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  private lease: WriterLease | undefined;
  private readonly now: () => number;
  private readonly snapshotFactory: SnapshotFactory;

  constructor(private readonly deps: CopilotArchiverDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.snapshotFactory = deps.snapshotFactory ?? createReadonlySnapshot;
  }

  /**
   * Ensure the archive dir exists, elect the writer, and start the periodic
   * sweep. The first tick runs synchronously so freshly-launched windows begin
   * capturing immediately. Safe to call once.
   */
  start(): void {
    const dir = path.dirname(this.deps.archiveDbPath);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      this.deps.onError?.(err);
      return;
    }
    const staleMs = Math.max(90_000, this.deps.sweepIntervalMs * 3);
    this.lease = new WriterLease(path.join(dir, WRITER_LOCK_BASENAME), staleMs, { now: this.now });

    this.tick();
    this.timer = setInterval(() => this.tick(), this.deps.sweepIntervalMs);
    // Don't keep the event loop alive on our account (harmless in the ext host).
    this.timer.unref?.();
  }

  /** Stop the sweep, close the store, and release the writer lease. */
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.closeStore();
    this.lease?.release();
    this.lease = undefined;
  }

  /** One sweep tick: (re)elect the writer, then prune + sweep if we hold it. */
  private tick(): void {
    if (this.lease === undefined) {
      return;
    }
    if (!this.lease.tryAcquire()) {
      // Another window is the writer — we are a pure reader; drop any store.
      this.closeStore();
      return;
    }
    if (this.store === undefined) {
      try {
        this.store = new IngestStore(this.deps.archiveDbPath);
      } catch (err) {
        this.deps.onError?.(err);
        return;
      }
    }
    this.sweepOnce();
    // Prune AFTER sweeping so any freshly-swept spans already older than the
    // retention window are dropped this tick (not left until the next one). They
    // sit below the watermark, so pruning them never causes a re-ingest loop.
    try {
      this.store.prune(this.deps.retentionMs, this.now());
    } catch (err) {
      this.deps.onError?.(err);
    }
  }

  /**
   * Copy new spans from every source into the archive. Returns the number of
   * spans written. No-op (returns 0) when this instance is not the writer.
   */
  sweepOnce(): number {
    const store = this.store;
    if (store === undefined) {
      return 0;
    }
    const archive = path.normalize(this.deps.archiveDbPath);
    let wrote = 0;
    for (const src of this.sweepSources()) {
      if (path.normalize(src) === archive) {
        continue; // never sweep the archive into itself
      }
      const mtime = sourceMtime(src);
      const wm = store.readWatermark(src);
      if (mtime !== undefined && typeof wm?.sourceMtimeMs === 'number' && wm.sourceMtimeMs === mtime) {
        continue; // unchanged since the last sweep
      }

      let snap: ReadonlySnapshot;
      try {
        snap = this.snapshotFactory(src);
      } catch (err) {
        this.deps.onError?.(err); // one bad source never blocks the others
        continue;
      }
      let reader: Database | undefined;
      try {
        reader = new Database(snap.dbPath, { readOnly: true, fileMustExist: true });
        const since = wm?.lastEndMs ?? 0;
        const rows = readSpansSince(reader, since);
        if (rows.spans.length > 0) {
          wrote += store.writeSpans(rows);
          let maxEnd = since;
          for (const s of rows.spans) {
            if (s.end_time_ms > maxEnd) {
              maxEnd = s.end_time_ms;
            }
          }
          store.writeWatermark(src, Math.max(0, maxEnd - GRACE_MS), snap.sourceMtimeMs, this.now());
        } else {
          // Nothing new — still record the mtime so we skip it next time.
          store.writeWatermark(src, since, snap.sourceMtimeMs, this.now());
        }
      } catch (err) {
        this.deps.onError?.(err);
      } finally {
        reader?.close();
        snap.dispose();
      }
    }
    if (wrote > 0) {
      try {
        this.deps.signal();
      } catch (err) {
        this.deps.onError?.(err);
      }
    }
    return wrote;
  }

  /** The ordered set of source DB paths to sweep this tick. */
  private sweepSources(): string[] {
    const resolved = resolveDatabasePaths(this.deps.config, this.deps.environment);
    const sources = resolved.databases.map((d) => d.path);
    if (this.deps.liveIngestDbPath !== undefined && sourceMtime(this.deps.liveIngestDbPath) !== undefined) {
      sources.push(this.deps.liveIngestDbPath);
    }
    return sources;
  }

  private closeStore(): void {
    this.store?.close();
    this.store = undefined;
  }
}

/**
 * Read every span with `end_time_ms > sinceEndMs` from an opened read-only source
 * DB, plus the `span_attributes` for exactly those spans (chunked to bound the
 * `IN (...)` placeholder count). `span_events` are intentionally NOT copied — the
 * read layer never queries them (verified) and, like the live-OTLP ingest path,
 * the archive holds only `spans` + `span_attributes`.
 */
function readSpansSince(db: Database, sinceEndMs: number): SpanRows {
  const spans = db.all(
    `SELECT ${SPAN_COLUMNS.join(', ')} FROM spans WHERE end_time_ms > ? ORDER BY end_time_ms ASC`,
    [sinceEndMs],
  ) as unknown as SpanRow[];

  const attributes: AttrRow[] = [];
  const ids = spans.map((s) => s.span_id);
  for (let i = 0; i < ids.length; i += ATTR_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + ATTR_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const rows = db.all(
      `SELECT span_id, key, value FROM span_attributes WHERE span_id IN (${placeholders})`,
      chunk,
    ) as unknown as AttrRow[];
    for (const a of rows) {
      attributes.push(a);
    }
  }
  return { spans, attributes };
}
