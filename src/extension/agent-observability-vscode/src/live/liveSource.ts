/**
 * The shared "live source" seam.
 *
 * A live source is anything that detects new on-machine agent activity in
 * near-real-time and asks the extension to re-render: Copilot's localhost OTLP
 * receiver ({@link ../otel/liveOtlpService.LiveOtlpService}) and Claude Code's
 * transcript file watcher ({@link ./claudeWatcher.ClaudeWatcher}). Each is a dumb
 * producer — it only needs to start, stop, and `signal()` the
 * {@link ./liveUpdateController.LiveUpdateController} when something changed. The
 * controller owns the single debounce and the refresh fan-out, so a burst from
 * either source (or both at once) coalesces into one render.
 *
 * Keeping the contract this small means a third source (a future agent's logs,
 * another exporter) is one class that calls `signal()`, not a wiring rewrite.
 */
export interface LiveSource {
  /** Human-readable name for diagnostics/logs (e.g. `Copilot OTLP receiver`). */
  readonly label: string;

  /**
   * Begin producing change signals. May be async (e.g. binding a socket). A
   * source MUST NOT throw out of `start`; surface setup failures via its own
   * error sink and degrade to inert so one source can't break the others.
   */
  start(): void | Promise<void>;

  /** Stop producing and release every held resource (sockets, watchers, DBs). */
  stop(): void;
}
