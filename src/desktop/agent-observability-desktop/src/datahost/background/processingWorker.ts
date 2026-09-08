import { Worker } from 'node:worker_threads';
import type { WorkerOptions } from 'node:worker_threads';
import type { BackgroundMessage } from './protocol';

/**
 * Startup maintenance can hold the archive's cross-process writer lease.
 * Never interrupt it between acquisition and finally/release. The worker sends
 * ready after maintenance, before parsing; only then may terminate interrupt
 * the index writer (SQLite rolls back that worker's transaction on teardown).
 * A crash also settles this barrier, so a failed launch never wedges mutation.
 */
export class ProcessingWorker extends Worker {
  private readonly safeToStop: Promise<void>;

  constructor(file: string, options: WorkerOptions) {
    super(file, options);
    this.safeToStop = new Promise((resolve) => {
      this.on('message', (message: BackgroundMessage) => {
        if (message.type === 'ready') { resolve(); }
      });
      this.once('exit', () => resolve());
    });
  }

  override async terminate(): Promise<number> {
    await this.safeToStop;
    return super.terminate();
  }
}