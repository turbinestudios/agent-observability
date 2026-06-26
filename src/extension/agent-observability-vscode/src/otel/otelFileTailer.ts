import * as fs from 'node:fs';
import * as path from 'node:path';

export interface FileTailerOptions {
  /** Absolute path to the JSON-lines file Copilot's OTel file exporter writes. */
  filePath: string;
  /** Coalescing window (ms) between a change signal and the incremental read. */
  debounceMs: number;
  /** Receives the complete new lines appended since the last read. */
  onLines: (lines: string[]) => void;
  /** Optional diagnostics sink; the tailer never throws into its callers. */
  onError?: (err: unknown) => void;
}

/**
 * Tails an append-only JSON-lines file for near-real-time updates — the same
 * technique a Claude Code session viewer uses on the agent transcript, applied
 * here to the file Copilot's OpenTelemetry "file" exporter writes.
 *
 * Design notes:
 *   - **Incremental, not full re-read.** The OTel outfile accumulates across
 *     sessions and can grow large, so we track a byte offset and read only the
 *     appended bytes, buffering a trailing partial line until its newline lands.
 *   - **Start at EOF.** We begin from the current end so only NEW spans stream;
 *     replaying a long backlog would be slow and is historical (the SQLite path
 *     already serves history).
 *   - **`fs.watch` + a size-guarded poll backstop.** A raw directory watcher is
 *     the primary, low-latency signal; a coarse interval guarantees liveness if
 *     the platform coalesces or drops watch events. Both funnel through one
 *     debounce, and the size guard makes the poll a no-op when nothing changed.
 *   - **Truncation/rotation safe.** If the file shrinks below our offset we reset
 *     to its start.
 */
export class OtelFileTailer {
  private offset = 0;
  private lastSize = -1;
  private remainder = '';
  private watcher: fs.FSWatcher | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly opts: FileTailerOptions) {}

  start(): void {
    try {
      const size = fs.statSync(this.opts.filePath).size;
      this.offset = size;
      this.lastSize = size;
    } catch {
      // File not created until Copilot first flushes; readNew handles ENOENT.
      this.offset = 0;
      this.lastSize = -1;
    }
    this.watchDirectory();
    const pollMs = Math.max(1000, this.opts.debounceMs * 2);
    this.poll = setInterval(() => this.schedule(), pollMs);
    this.poll.unref?.();
  }

  private watchDirectory(): void {
    // Watch the containing directory (not the file handle): a checkpoint/rotation
    // can replace the file, and per-file watchers go stale when that happens.
    const dir = path.dirname(this.opts.filePath);
    const base = path.basename(this.opts.filePath);
    try {
      this.watcher = fs.watch(dir, (_event, filename) => {
        // `filename` can be null on some platforms — react to any event then.
        if (filename === null || filename === base) {
          this.schedule();
        }
      });
    } catch (err) {
      // Directory not present yet, or watch unsupported — poll-only still works.
      this.opts.onError?.(err);
    }
  }

  private schedule(): void {
    if (this.disposed) {
      return;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => this.readNew(), this.opts.debounceMs);
    this.debounceTimer.unref?.();
  }

  private readNew(): void {
    if (this.disposed) {
      return;
    }
    let size: number;
    try {
      size = fs.statSync(this.opts.filePath).size;
    } catch {
      return; // not created yet / transient
    }

    if (size === this.lastSize && size === this.offset) {
      return; // nothing new since the last successful read
    }
    this.lastSize = size;

    if (size < this.offset) {
      // Truncated or rotated — restart from the new file's beginning.
      this.offset = 0;
      this.remainder = '';
    }
    if (size === this.offset) {
      return;
    }

    let fd: number | undefined;
    let chunk: Buffer;
    try {
      fd = fs.openSync(this.opts.filePath, 'r');
      const length = size - this.offset;
      chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, this.offset);
      this.offset = size;
    } catch (err) {
      this.opts.onError?.(err);
      return;
    } finally {
      if (fd !== undefined) {
        try {
          fs.closeSync(fd);
        } catch {
          /* ignore */
        }
      }
    }

    const text = this.remainder + chunk.toString('utf8');
    const parts = text.split('\n');
    // The last element is everything after the final newline — an incomplete
    // line if the writer was mid-flush. Hold it until the rest arrives.
    this.remainder = parts.pop() ?? '';
    const lines = parts
      .map((line) => line.replace(/\r$/, ''))
      .filter((line) => line.length > 0);
    if (lines.length > 0) {
      this.opts.onLines(lines);
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.watcher !== undefined) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = undefined;
    }
    if (this.poll !== undefined) {
      clearInterval(this.poll);
      this.poll = undefined;
    }
    if (this.debounceTimer !== undefined) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = undefined;
    }
  }
}
