import * as fs from 'node:fs';
import * as os from 'node:os';

/**
 * Cross-process single-writer election via an atomically-created lock file.
 *
 * The durable archive ({@link ./archivePaths}) is a single file shared by every
 * VS Code window and edition on one OS user. Only ONE instance may WRITE it,
 * because the bundled `node-sqlite3-wasm` runs on an Emscripten VFS that does
 * NOT provide reliable cross-process byte-range locks, and the archive is kept
 * in rollback-journal mode (the driver cannot open WAL). READERS are always safe
 * — they read a private snapshot copy, never the live file — so only writers
 * need serializing.
 *
 * The holder rewrites the lock's timestamp on every {@link heartbeat}; a lock
 * older than `staleMs` (a crashed or hung writer) is reclaimed by the next
 * {@link tryAcquire}. `fs.openSync(path, 'wx')` is the atomic election primitive
 * (exclusive create), independent of SQLite locking. Vscode-free and
 * clock-injectable so it is unit-testable headless.
 */

/** Injectable clock so tests can drive staleness deterministically. */
export interface WriterLeaseClock {
  now(): number;
}

const defaultClock: WriterLeaseClock = { now: () => Date.now() };

/** The lock file's JSON payload — owner identity + heartbeat timestamp. */
interface LeasePayload {
  pid: number;
  host: string;
  ts: number;
}

export class WriterLease {
  private held = false;

  constructor(
    private readonly lockPath: string,
    private readonly staleMs: number,
    private readonly clock: WriterLeaseClock = defaultClock,
    private readonly pid: number = process.pid,
    private readonly host: string = os.hostname(),
  ) {}

  /** Whether THIS instance currently holds the lock. */
  get isHeld(): boolean {
    return this.held;
  }

  /**
   * Try to become the writer. Returns `true` if this instance now holds the
   * lock. Creates the lock atomically; when it already exists, reclaims it only
   * if its timestamp is older than `staleMs` (or the file is corrupt). Idempotent
   * while held (refreshes the heartbeat and returns `true`).
   */
  tryAcquire(): boolean {
    if (this.held) {
      this.heartbeat();
      return this.held;
    }
    if (this.createExclusive()) {
      this.held = true;
      return true;
    }
    // Someone holds it — reclaim only when stale or unreadable/corrupt.
    const existing = this.read();
    if (existing === undefined || this.clock.now() - existing.ts > this.staleMs) {
      try {
        fs.rmSync(this.lockPath, { force: true });
      } catch {
        return false; // lost the race to another reclaimer; stay a reader
      }
      if (this.createExclusive()) {
        this.held = true;
        return true;
      }
    }
    return false;
  }

  /**
   * Refresh the lock's timestamp. No-op when not held. If the lock on disk is no
   * longer ours (our lease went stale while we were hung and another instance
   * reclaimed it), step down instead of overwriting it — this prevents a
   * split-brain where two instances both believe they are the writer.
   */
  heartbeat(): void {
    if (!this.held) {
      return;
    }
    const existing = this.read();
    if (existing !== undefined && (existing.pid !== this.pid || existing.host !== this.host)) {
      this.held = false;
      return;
    }
    try {
      fs.writeFileSync(this.lockPath, JSON.stringify(this.payload()));
    } catch {
      // The dir/file vanished under us — drop our claim so another instance can
      // take over; a later tryAcquire re-creates it.
      this.held = false;
    }
  }

  /** Release the lock if held (best-effort), only when it is still ours. */
  release(): void {
    if (!this.held) {
      return;
    }
    this.held = false;
    const existing = this.read();
    if (existing !== undefined && existing.pid === this.pid && existing.host === this.host) {
      try {
        fs.rmSync(this.lockPath, { force: true });
      } catch {
        // best-effort; a leftover lock goes stale and is reclaimed later.
      }
    }
  }

  /** Atomic exclusive create. `true` on success; `false` if it already exists. */
  private createExclusive(): boolean {
    try {
      const fd = fs.openSync(this.lockPath, 'wx');
      try {
        fs.writeSync(fd, JSON.stringify(this.payload()));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch {
      // EEXIST (already held) or ENOENT (dir missing) → not acquired.
      return false;
    }
  }

  private payload(): LeasePayload {
    return { pid: this.pid, host: this.host, ts: this.clock.now() };
  }

  private read(): LeasePayload | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.lockPath, 'utf8')) as Partial<LeasePayload>;
      if (typeof parsed.ts === 'number' && typeof parsed.pid === 'number') {
        return {
          pid: parsed.pid,
          host: typeof parsed.host === 'string' ? parsed.host : '',
          ts: parsed.ts,
        };
      }
      return undefined;
    } catch {
      return undefined;
    }
  }
}
