/**
 * The hourly re-export while the app runs, once the user has turned sharing
 * on and left automatic export enabled. The first run waits a couple of
 * minutes after startup so the index has settled, then repeats. Every tick is
 * delegated to the caller, which serializes it behind the background
 * controller so an export never overlaps an index pass.
 */
export const EXPORT_FIRST_DELAY_MS = 2 * 60_000;
export const EXPORT_INTERVAL_MS = 60 * 60_000;

export interface SchedulerTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const defaultTimers: SchedulerTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export interface ExportSchedulerDeps {
  /** Whether sharing AND automatic export are currently on. */
  enabled: () => boolean;
  run: () => void;
  timers?: SchedulerTimers;
  firstDelayMs?: number;
  intervalMs?: number;
}

export class ExportScheduler {
  private readonly timers: SchedulerTimers;
  private first: unknown;
  private interval: unknown;

  constructor(private readonly deps: ExportSchedulerDeps) {
    this.timers = deps.timers ?? defaultTimers;
  }

  /** (Re)arm according to the current settings. Safe to call on every change. */
  arm(): void {
    this.disarm();
    if (!this.deps.enabled()) {
      return;
    }
    this.first = this.timers.setTimeout(() => {
      this.first = undefined;
      this.tick();
      this.interval = this.timers.setInterval(() => this.tick(), this.deps.intervalMs ?? EXPORT_INTERVAL_MS);
    }, this.deps.firstDelayMs ?? EXPORT_FIRST_DELAY_MS);
  }

  disarm(): void {
    if (this.first !== undefined) {
      this.timers.clearTimeout(this.first);
      this.first = undefined;
    }
    if (this.interval !== undefined) {
      this.timers.clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  armed(): boolean {
    return this.first !== undefined || this.interval !== undefined;
  }

  private tick(): void {
    if (!this.deps.enabled()) {
      this.disarm();
      return;
    }
    try {
      this.deps.run();
    } catch {
      // The run reports its own failure through the export state.
    }
  }
}
