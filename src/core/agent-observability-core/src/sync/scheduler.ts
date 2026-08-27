/**
 * Background sync scheduler (Phase 7).
 *
 * Runs {@link SyncEngine.runSync}`({ manual: false })` on a fixed interval, but
 * ONLY when `agentObservability.sync.enabled` is true. Background sync is OFF by
 * default AND the engine still re-checks the consent+key gate on every tick — two
 * independent locks, so nothing is ever uploaded without explicit opt-in.
 *
 * The scheduler is intentionally `vscode`-free (it takes a tiny config surface and
 * an optional `onRun` callback the extension uses to refresh the Sync view), so it
 * unit-tests headless with vitest fake timers.
 */

/** Config surface the scheduler reads (satisfied by {@link Configuration}). */
export interface SchedulerConfig {
  isSyncEnabled(): boolean;
  /** Minutes between ticks; the Configuration clamps this to the documented min. */
  getSyncIntervalMinutes(): number;
}

/** What the scheduler drives — satisfied by {@link SyncEngine}. */
export interface SchedulableEngine {
  runSync(input: { manual: boolean }): Promise<unknown>;
}

/** Minimum tick interval (minutes), mirroring the config minimum. */
const MIN_INTERVAL_MINUTES = 5;

export class SyncScheduler {
  private timer: ReturnType<typeof setInterval> | undefined;

  /**
   * @param config interval + enabled flag source.
   * @param engine the sync engine to drive on each tick.
   * @param onRun optional hook fired after each tick completes (used to refresh
   *   the Sync view). Errors from it are swallowed so a view refresh failure never
   *   breaks scheduling.
   */
  constructor(
    private readonly config: SchedulerConfig,
    private readonly engine: SchedulableEngine,
    private readonly onRun?: () => void,
  ) {}

  /**
   * (Re)start the timer to match current config. When sync is disabled this is a
   * no-op that also clears any existing timer. Call again on config change.
   */
  start(): void {
    this.clearTimer();
    if (!this.config.isSyncEnabled()) {
      return; // OFF by default — no background timer at all.
    }
    const minutes = Math.max(MIN_INTERVAL_MINUTES, this.config.getSyncIntervalMinutes());
    const periodMs = minutes * 60 * 1000;
    this.timer = setInterval(() => {
      void this.tick();
    }, periodMs);
    // Do not keep the host process alive solely for this timer (best-effort; not
    // all timer impls expose unref).
    const t = this.timer as unknown as { unref?: () => void };
    t.unref?.();
  }

  /** Re-evaluate config and re-arm the timer (call from `onDidChangeConfiguration`). */
  reschedule(): void {
    this.start();
  }

  /**
   * One scheduled cycle. The engine itself re-checks the gate and no-ops when
   * closed, so this just drives it and reports. Never throws.
   */
  private async tick(): Promise<void> {
    try {
      await this.engine.runSync({ manual: false });
    } catch {
      // A scheduled run must never crash the timer; failures are recorded by the
      // engine's own history. Swallow here.
    } finally {
      try {
        this.onRun?.();
      } catch {
        // ignore view-refresh failures
      }
    }
  }

  /** Stop the timer and release it. Safe to call repeatedly. */
  dispose(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}
