import * as path from 'node:path';
import Database from 'better-sqlite3';
import { READ_INDEX_DDL } from '@agent-observability/core/src/telemetry/schemaIndexes';
import { WriterLease } from '@agent-observability/core/src/otel/writerLease';
import type { Configuration } from '@agent-observability/core/src/config/configuration';
import { pickCopilotDatabase } from './indexer/copilotIndexer';

/**
 * Give this app's OWN Copilot archive the read layer's indexes, once per launch.
 *
 * Without them the first session opened after startup full-scans
 * `span_attributes` — the table holding every prompt and tool definition, ~1.6 GB
 * on a well-used archive — and takes minutes rather than seconds. The read path
 * can build them on its private snapshot copy
 * ({@link @agent-observability/core/src/telemetry/database.ensureSnapshotIndexes}),
 * but that copy is thrown away and rebuilt whenever the source changes, so the
 * ~2 s build would be paid again and again. Writing them into the archive itself
 * pays it exactly once, for good.
 *
 * Two rules make this safe to run unattended:
 *
 *  - Only ever against OUR archive. `pickCopilotDatabase` flags it, and anything
 *    else — Copilot's own `agent-traces.db`, a `sqlitePath` override — is left
 *    strictly alone, which is the same promise the indexer makes.
 *  - Only while holding the archive's writer lease, so this can never interleave
 *    with a VS Code window mid-sweep. Losing the lease is a non-event: the holder
 *    is an older VS Code extension's archiver, which applies the same DDL on every open.
 */

/** Matches the archiver's own lock file, so both elect the same single writer. */
const WRITER_LOCK_BASENAME = 'writer.lock';

/**
 * Long enough that a sweeping window is never mistaken for a crashed one (the
 * archiver's own floor is 90 s), since reclaiming a live writer's lease is the
 * one thing this must not do for a purely optional optimization.
 */
const LEASE_STALE_MS = 90_000;

/** What happened, for the datahost's index-status note. Undefined when it worked. */
export function ensureArchiveIndexes(config: Configuration): string | undefined {
  const candidate = pickCopilotDatabase(config);
  if (candidate === undefined || !candidate.archive) {
    // Nothing of ours to index; the snapshot copy carries the indexes instead.
    return undefined;
  }

  const lease = new WriterLease(
    path.join(path.dirname(candidate.path), WRITER_LOCK_BASENAME),
    LEASE_STALE_MS,
  );
  if (!lease.tryAcquire()) {
    return undefined; // The extension is writing; it applies the same DDL.
  }

  let db: Database.Database | undefined;
  try {
    db = new Database(candidate.path, { fileMustExist: true });
    db.exec(READ_INDEX_DDL);
    return undefined;
  } catch (err) {
    // Advisory only — an unindexed archive is slow, not broken.
    return `could not index the archive (${err instanceof Error ? err.message : String(err)})`;
  } finally {
    db?.close();
    lease.release();
  }
}
