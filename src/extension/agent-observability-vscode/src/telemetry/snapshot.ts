import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';

/**
 * Read-only snapshot of the live Copilot telemetry DB.
 *
 * `agent-traces.db` runs in WAL mode and is typically held open by VS Code's
 * Copilot writer, so the freshest committed data usually lives only in the
 * `-wal` sidecar, not yet checkpointed into the main `.db`. To get a consistent,
 * UP-TO-DATE snapshot WITHOUT any lock contention or write risk against the real
 * file, we:
 *
 *   1. Copy `*.db` plus its `*.db-wal` and `*.db-shm` sidecars (when present)
 *      to a private temp directory, as close together in time as possible.
 *   2. Normalize the COPY's journal mode so the bundled driver can open it.
 *      node-sqlite3-wasm has no WAL / shared-memory VFS and therefore cannot
 *      open ANY file whose header is flagged WAL mode (it fails with "unable to
 *      open database file"). So we fold the COPY's committed `-wal` frames into
 *      the COPY's main file ourselves (a private, read-only-equivalent
 *      checkpoint) and rewrite its header from WAL to rollback-journal — giving
 *      the WAL-incapable driver the same fresh data a WAL-capable reader sees,
 *      instead of waiting for Copilot to checkpoint (see
 *      {@link normalizeJournalMode}).
 *   3. Callers open the COPY read-only (node-sqlite3-wasm { readOnly: true }).
 *   4. {@link ReadonlySnapshot.dispose} deletes the temp copy.
 *
 * We NEVER open, checkpoint, or write the original file.
 */
export interface ReadonlySnapshot {
  /** Absolute path to the copied `.db` file inside the temp dir. */
  dbPath: string;
  /** Source mtime (epoch ms) captured at copy time, for skip-if-unchanged. */
  sourceMtimeMs: number;
  /** Delete the temp copy and its sidecars. Safe to call more than once. */
  dispose(): void;
}

const WAL_SUFFIX = '-wal';
const SHM_SUFFIX = '-shm';

/**
 * SQLite database header: the file-format write/read version bytes (offsets 18
 * and 19). Both are `2` for a WAL-mode DB and `1` for a rollback-journal DB.
 * @see https://www.sqlite.org/fileformat2.html#file_format_version_numbers
 */
const HEADER_WRITE_VERSION_OFFSET = 18;
const HEADER_READ_VERSION_OFFSET = 19;
const SQLITE_VERSION_WAL = 2;
const SQLITE_VERSION_ROLLBACK = 1;

/** WAL file layout: a 32-byte file header, then frames of a 24-byte header + page. */
const WAL_FILE_HEADER_BYTES = 32;
const WAL_FRAME_HEADER_BYTES = 24;
/**
 * The two valid WAL magic numbers (header bytes 0-3, read big-endian). They
 * differ only in how the per-frame checksums interpret their 32-bit words:
 * `…82` → little-endian, `…83` → big-endian. The header fields themselves are
 * always big-endian regardless.
 * @see https://www.sqlite.org/fileformat2.html#wal_file_format
 */
const WAL_MAGIC_LITTLE_ENDIAN = 0x377f0682;
const WAL_MAGIC_BIG_ENDIAN = 0x377f0683;

/**
 * Create a read-only snapshot copy of the database at `dbPath`.
 *
 * @throws if the source `.db` does not exist or cannot be read (the caller's
 * service layer classifies the error code, e.g. ENOENT → missingDb,
 * EACCES/EPERM → permission).
 */
export function createReadonlySnapshot(dbPath: string): ReadonlySnapshot {
  // Capture source mtime first; surfaces ENOENT/EACCES before any temp work.
  const sourceStat = fs.statSync(dbPath);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-obs-'));
  const baseName = path.basename(dbPath);
  const destDb = path.join(tempDir, baseName);

  // Copy main DB first, then sidecars. Sidecars are optional (a cleanly
  // checkpointed DB may have none); copy them only when present.
  fs.copyFileSync(dbPath, destDb);
  copyIfExists(dbPath + WAL_SUFFIX, destDb + WAL_SUFFIX);
  copyIfExists(dbPath + SHM_SUFFIX, destDb + SHM_SUFFIX);

  // Make the copy openable by the WAL-incapable bundled driver. On any failure
  // (including a pending-WAL bail-out) clean up the temp dir before rethrowing.
  try {
    normalizeJournalMode(destDb);
  } catch (err) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw err;
  }

  let disposed = false;
  return {
    dbPath: destDb,
    sourceMtimeMs: sourceStat.mtimeMs,
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; a leftover temp file is harmless and the OS
        // reclaims tmpdir. Never throw from dispose.
      }
    },
  };
}

/** Copy `from` → `to` only if `from` exists; ignore a benign race ENOENT. */
function copyIfExists(from: string, to: string): void {
  try {
    fs.copyFileSync(from, to);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return;
    }
    throw err;
  }
}

/**
 * Make the COPIED database openable by node-sqlite3-wasm, whose VFS has no WAL /
 * shared-memory support and so cannot open any file flagged WAL mode (header
 * bytes 18-19 == 2) — it fails with "unable to open database file". Copilot
 * keeps `agent-traces.db` in WAL mode, so without this every open would fail.
 *
 * For a WAL-flagged copy we fold any committed `-wal` frames into the copy's
 * main file ({@link replayWal}) so the reader sees the latest committed state —
 * not just the last checkpoint — then rewrite the two header version bytes from
 * WAL (2) to rollback-journal (1) IN THE COPY ONLY and drop the now-irrelevant
 * sidecars (rollback-mode SQLite ignores `-wal`/`-shm`). The original file is
 * never touched. A db that is already rollback-journal needs no work.
 */
function normalizeJournalMode(destDb: string): void {
  const fd = fs.openSync(destDb, 'r+');
  let isWal: boolean;
  try {
    const header = Buffer.alloc(20);
    fs.readSync(fd, header, 0, header.length, 0);
    isWal =
      header[HEADER_WRITE_VERSION_OFFSET] === SQLITE_VERSION_WAL ||
      header[HEADER_READ_VERSION_OFFSET] === SQLITE_VERSION_WAL;
  } finally {
    fs.closeSync(fd);
  }
  if (!isWal) {
    return; // Already a rollback-journal DB; openable as-is.
  }

  // Fold committed WAL frames into the copy's main file, then flip the copy's
  // header to rollback-journal. Order matters: replay rewrites page 1 (which
  // carries the header), so the version-byte rewrite must come after.
  replayWal(destDb, destDb + WAL_SUFFIX);

  const fd2 = fs.openSync(destDb, 'r+');
  try {
    const rollback = Buffer.from([SQLITE_VERSION_ROLLBACK, SQLITE_VERSION_ROLLBACK]);
    fs.writeSync(fd2, rollback, 0, rollback.length, HEADER_WRITE_VERSION_OFFSET);
  } finally {
    fs.closeSync(fd2);
  }

  // The copy is now a rollback-journal DB; SQLite would ignore these anyway.
  removeIfExists(destDb + WAL_SUFFIX);
  removeIfExists(destDb + SHM_SUFFIX);
}

/**
 * Fold the committed frames of the copied `-wal` sidecar into the copied main
 * `.db`. This is a minimal checkpoint performed ENTIRELY on our private temp
 * copy (the original file is never touched), giving the WAL-incapable
 * node-sqlite3-wasm driver the data Copilot has committed but not yet
 * checkpointed — the same freshness a WAL-capable reader (e.g. the Agent Debug
 * Logs) sees, with no waiting for Copilot to checkpoint.
 *
 * Walks frames validating each against the WAL header salt and the cumulative
 * SQLite WAL checksum, and applies only the page images up to and including the
 * last valid COMMIT frame. Trailing uncommitted or torn frames are ignored, so
 * the result is always a consistent committed snapshot. When the `-wal` is
 * absent, too small, or unrecognized — or holds no complete committed
 * transaction — nothing is applied and the main file's own last-checkpoint
 * state is used (consistent, possibly slightly stale; a refresh catches up).
 */
function replayWal(destDb: string, walPath: string): void {
  const walSize = fileSize(walPath);
  if (walSize < WAL_FILE_HEADER_BYTES) {
    return; // No sidecar, or header-only (nothing to replay).
  }

  const wal = fs.readFileSync(walPath);
  const magic = wal.readUInt32BE(0);
  const bigEndian = magic === WAL_MAGIC_BIG_ENDIAN;
  if (!bigEndian && magic !== WAL_MAGIC_LITTLE_ENDIAN) {
    return; // Not a WAL we recognize; leave the main file as-is.
  }
  const pageSize = wal.readUInt32BE(8);
  if (pageSize <= 0) {
    return;
  }
  const salt = wal.subarray(16, 24);
  const frameSize = WAL_FRAME_HEADER_BYTES + pageSize;
  const frameCount = Math.floor((walSize - WAL_FILE_HEADER_BYTES) / frameSize);

  // The cumulative checksum seeds from the first 24 bytes of the WAL header and
  // then runs through every frame in order.
  let [s0, s1] = walChecksum(wal, 0, 24, 0, 0, bigEndian);

  // Page images in WAL order; remember the index of the last commit frame and
  // the database size (in pages) that frame committed.
  const frames: { pageNumber: number; data: Buffer }[] = [];
  let lastCommitIndex = -1;
  let committedDbPages = 0;

  for (let i = 0; i < frameCount; i++) {
    const base = WAL_FILE_HEADER_BYTES + i * frameSize;
    const pageNumber = wal.readUInt32BE(base);
    const dbSizeAfterCommit = wal.readUInt32BE(base + 4);
    const frameSalt = wal.subarray(base + 8, base + 16);
    const storedC0 = wal.readUInt32BE(base + 16);
    const storedC1 = wal.readUInt32BE(base + 20);

    // A salt mismatch means this frame belongs to a different (overwritten) WAL
    // epoch — everything from here on is stale. The checksum covers the first 8
    // header bytes plus the page content and must match for the frame to count.
    if (!frameSalt.equals(salt)) {
      break;
    }
    let c0: number;
    let c1: number;
    [c0, c1] = walChecksum(wal, base, 8, s0, s1, bigEndian);
    [c0, c1] = walChecksum(wal, base + WAL_FRAME_HEADER_BYTES, pageSize, c0, c1, bigEndian);
    if (c0 !== storedC0 || c1 !== storedC1) {
      break; // Torn or uncommitted tail frame.
    }
    s0 = c0;
    s1 = c1;

    frames.push({ pageNumber, data: wal.subarray(base + WAL_FRAME_HEADER_BYTES, base + frameSize) });
    if (dbSizeAfterCommit !== 0) {
      lastCommitIndex = frames.length - 1;
      committedDbPages = dbSizeAfterCommit;
    }
  }

  if (lastCommitIndex < 0) {
    return; // No complete committed transaction in the WAL.
  }

  // Latest page image wins, restricted to frames up to the last commit.
  const latest = new Map<number, Buffer>();
  for (let i = 0; i <= lastCommitIndex; i++) {
    latest.set(frames[i].pageNumber, frames[i].data);
  }

  const fd = fs.openSync(destDb, 'r+');
  try {
    for (const [pageNumber, data] of latest) {
      fs.writeSync(fd, data, 0, data.length, (pageNumber - 1) * pageSize);
    }
    // Honor the committed database size (covers truncation/vacuum as well as growth).
    fs.ftruncateSync(fd, committedDbPages * pageSize);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Cumulative SQLite WAL checksum over `len` bytes of `buf` starting at `offset`
 * (`len` must be a multiple of 8), continuing from the running `[s0, s1]`. The
 * 32-bit words are read big- or little-endian per the WAL header's magic.
 * @see https://www.sqlite.org/fileformat2.html#checksum_algorithm
 */
function walChecksum(
  buf: Buffer,
  offset: number,
  len: number,
  s0: number,
  s1: number,
  bigEndian: boolean,
): [number, number] {
  for (let i = 0; i < len; i += 8) {
    const x0 = bigEndian ? buf.readUInt32BE(offset + i) : buf.readUInt32LE(offset + i);
    const x1 = bigEndian ? buf.readUInt32BE(offset + i + 4) : buf.readUInt32LE(offset + i + 4);
    s0 = (s0 + x0 + s1) >>> 0;
    s1 = (s1 + x1 + s0) >>> 0;
  }
  return [s0, s1];
}

/** Size of `p` in bytes, or 0 when it does not exist / cannot be stat'd. */
function fileSize(p: string): number {
  try {
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

/** Best-effort delete of `p`; ignore absence and any error. */
function removeIfExists(p: string): void {
  try {
    fs.rmSync(p, { force: true });
  } catch {
    // Leftover sidecar in our private temp dir is harmless; never throw here.
  }
}

/** Current mtime (epoch ms) of a source DB, or `undefined` if unreadable. */
export function sourceMtime(dbPath: string): number | undefined {
  try {
    return fs.statSync(dbPath).mtimeMs;
  } catch {
    return undefined;
  }
}
