import { LiveSource } from './liveSource';

/**
 * Coordinates every {@link LiveSource} behind ONE debounce and ONE refresh.
 *
 * Sources call {@link signal} whenever they ingest/observe new activity; the
 * controller coalesces a burst into a single {@link LiveUpdateControllerDeps.onRefresh}
 * per debounce window, so the views re-render in near-real-time without thrashing
 * on every span or file append. This is the shared "watcher pattern" plumbing:
 * the Copilot OTLP receiver and the Claude transcript watcher both feed the same
 * timer instead of each owning their own.
 *
 * Vscode-free (the extension supplies `onRefresh` + the sources), so it is
 * unit-testable headless.
 */

const DEFAULT_DEBOUNCE_MS = 400;

export interface LiveUpdateControllerDeps {
  /** Fired (debounced) after any source signals — wire to the live refresh. */
  onRefresh: () => void;
  /** Debounce window in ms; coalesces a burst of signals into one refresh. */
  debounceMs?: number;
  /** Optional error sink for a source's `start` failure or an `onRefresh` throw. */
  onError?: (err: unknown) => void;
}

export class LiveUpdateController {
  private readonly sources: LiveSource[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;
  private started = false;

  constructor(private readonly deps: LiveUpdateControllerDeps) {}

  /** Add a source. Register every source BEFORE {@link start}. */
  register(source: LiveSource): void {
    this.sources.push(source);
  }

  /** Whether at least one source has been registered. */
  get sourceCount(): number {
    return this.sources.length;
  }

  /**
   * Start every registered source. A source that fails to start is reported via
   * {@link LiveUpdateControllerDeps.onError} and skipped — the others still run.
   */
  async start(): Promise<void> {
    this.started = true;
    for (const source of this.sources) {
      try {
        await source.start();
      } catch (err) {
        this.deps.onError?.(err);
      }
    }
  }

  /**
   * Note that a source observed new activity. Coalesced: the first signal in a
   * window arms the timer; later signals before it fires are folded in.
   */
  signal(): void {
    if (!this.started) {
      return;
    }
    this.pending = true;
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.pending) {
        this.pending = false;
        try {
          this.deps.onRefresh();
        } catch (err) {
          this.deps.onError?.(err);
        }
      }
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  /** Stop every source and cancel any pending refresh. */
  stop(): void {
    this.started = false;
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pending = false;
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // best-effort: a source's teardown must not block the others.
      }
    }
    this.sources.length = 0;
  }
}
