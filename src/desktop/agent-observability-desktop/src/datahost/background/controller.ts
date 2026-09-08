import type { BackgroundMessage, BackgroundWorker } from './protocol';

interface Run {
  worker: BackgroundWorker;
  done: boolean;
  failed: boolean;
}

/**
 * One background writer, independent of interactive RPC. Refresh storms fold
 * into one follow-up run. Destructive/config mutations serialize, stop the
 * worker and await its EXIT before touching the index or source, then start
 * one run with the latest settings. Stopped workers' late messages are ignored.
 * No crash retry loop: Refresh retries explicitly after reporting the failure.
 */
export class BackgroundController {
  private current: Run | undefined;
  private queued = false;
  private pauses = 0;
  private mutations: Promise<void> = Promise.resolve();
  private stopping: Promise<void> | undefined;
  private disposed = false;

  constructor(private readonly deps: {
    spawn: () => BackgroundWorker;
    onMessage: (message: BackgroundMessage) => void;
    onStart: () => void;
    onStopped: () => void;
    onError: (error: Error) => void;
  }) {}

  request(): void {
    if (this.disposed) {
      return;
    }
    this.queued = true;
    this.startIfReady();
  }

  private startIfReady(): void {
    if (this.disposed || !this.queued || this.current !== undefined || this.pauses > 0 || this.stopping !== undefined) {
      return;
    }
    this.queued = false;
    try {
      const run: Run = { worker: this.deps.spawn(), done: false, failed: false };
      this.current = run;
      run.worker.on('message', (message) => {
        if (this.current !== run || run.failed) {
          return;
        }
        if (message.type === 'done') {
          run.done = true;
        } else {
          try {
            this.deps.onMessage(message);
          } catch (error) {
            run.failed = true;
            this.deps.onError(error instanceof Error ? error : new Error(String(error)));
          }
        }
      });
      run.worker.on('error', (error) => {
        if (this.current === run) {
          run.failed = true;
          this.deps.onError(error);
        }
      });
      run.worker.on('exit', (code) => {
        if (this.current !== run) {
          return;
        }
        this.current = undefined;
        if (!run.failed && (!run.done || code !== 0)) {
          run.failed = true;
          this.deps.onError(new Error(`Background processing exited unexpectedly (${code}). Refresh to retry.`));
        }
        if (run.failed) {
          this.queued = false;
        }
        this.startIfReady();
      });
      this.deps.onStart();
    } catch (error) {
      this.deps.onError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Pause immediately, then serialize the stop/mutation/restart boundary. */
  exclusive<T>(mutate: () => T | Promise<T>): Promise<T> {
    if (this.disposed) {
      return Promise.reject(new Error('Background processing is closed.'));
    }
    this.pauses++;
    this.queued = true;
    const result = this.mutations.then(async () => {
      await this.stop();
      if (this.disposed) {
        throw new Error('Background processing is closed.');
      }
      return mutate();
    });
    this.mutations = result.then(() => undefined, () => undefined);
    return result.finally(() => {
      this.pauses--;
      this.startIfReady();
    });
  }

  private async stop(): Promise<void> {
    if (this.stopping !== undefined) {
      return this.stopping;
    }
    const run = this.current;
    if (run === undefined) {
      return;
    }
    this.current = undefined; // Revoke event authority BEFORE awaiting exit.
    const stopped = run.worker.terminate().then(() => this.deps.onStopped());
    this.stopping = stopped;
    try {
      await stopped;
      this.stopping = undefined;
    } catch (error) {
      // Keep a rejected stop barrier: never write/restart while a worker that
      // could still be writing has failed to terminate.
      this.queued = false;
      this.deps.onError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.queued = false;
    await this.stop();
  }
}