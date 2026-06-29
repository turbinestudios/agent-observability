import { LiveSource } from './liveSource';

/**
 * Near-real-time watcher over Claude Code's JSONL transcripts.
 *
 * Claude Code appends to `~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`
 * (and sub-agent side-chains) as a session progresses, so a recursive watch for
 * `**\/*.jsonl` create/change/delete events is the live signal — the symmetric
 * counterpart to Copilot's OTLP push receiver. Unlike Copilot, this needs NO
 * exporter configuration and NO restart: the files are always being written, so
 * watching them is enough.
 *
 * Each filesystem event just calls `signal()`; the {@link ./liveUpdateController.LiveUpdateController}
 * owns the debounce and the refresh fan-out (which invalidates the Claude
 * source's discovery so only the changed transcript re-parses). The watch
 * mechanism is injected via {@link FileWatchFactory} so the wiring is testable
 * headless without touching the real filesystem or the vscode API.
 */

/** A live watch over one directory tree; dispose to stop it. */
export interface WatchHandle {
  dispose(): void;
}

/** Host seam for creating a recursive `*.jsonl` watch over a directory. */
export interface FileWatchFactory {
  /**
   * Watch `dir` recursively for `*.jsonl` create/change/delete and invoke
   * `onEvent(changedPath)` for each. Implementations should never throw out of
   * the event callback.
   */
  watch(dir: string, onEvent: (changedPath: string) => void): WatchHandle;
}

export interface ClaudeWatcherDeps {
  /**
   * The Claude `projects` directories to watch, newest resolution wins. Resolved
   * lazily at {@link start} so a `CLAUDE_CONFIG_DIR` / override change is honored
   * on the next start. Directories that don't exist yet are simply not watched.
   */
  resolveDirs: () => string[];
  /** Creates the underlying watches (vscode `createFileSystemWatcher` in prod). */
  factory: FileWatchFactory;
  /** Called (un-debounced) on every transcript event; wire to the controller. */
  signal: () => void;
  /** Optional sink reporting which directories ended up being watched. */
  onWatching?: (dirs: readonly string[]) => void;
  onError?: (err: unknown) => void;
}

export class ClaudeWatcher implements LiveSource {
  readonly label = 'Claude Code transcript watcher';

  private handles: WatchHandle[] = [];

  constructor(private readonly deps: ClaudeWatcherDeps) {}

  start(): void {
    let dirs: string[];
    try {
      dirs = this.deps.resolveDirs();
    } catch (err) {
      this.deps.onError?.(err);
      return;
    }
    for (const dir of dirs) {
      try {
        this.handles.push(this.deps.factory.watch(dir, () => this.deps.signal()));
      } catch (err) {
        this.deps.onError?.(err);
      }
    }
    this.deps.onWatching?.(dirs);
  }

  stop(): void {
    for (const handle of this.handles) {
      try {
        handle.dispose();
      } catch {
        // best-effort
      }
    }
    this.handles = [];
  }
}
