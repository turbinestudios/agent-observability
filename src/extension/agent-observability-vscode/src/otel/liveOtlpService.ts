import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { IngestStore } from './ingestStore';
import { OtlpReceiver } from './otlpReceiver';
import { SpanRows } from './otlpToRows';

/**
 * Owns the live-OTLP pipeline: the {@link OtlpReceiver} (localhost push source)
 * and the {@link IngestStore} (the extension's own Copilot-schema DB the rest of
 * the stack reads). Each `/v1/traces` batch is written immediately, and a
 * debounced `onIngest` fires so the views/detector refresh in near-real-time
 * without thrashing on every span.
 *
 * Vscode-free (the extension supplies the storage path, port, and an `onIngest`
 * that re-renders + runs the notifier), so it is unit-testable headless.
 */

const DEFAULT_DEBOUNCE_MS = 400;
const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60_000; // keep ~7 days so the snapshot stays small

export interface LiveOtlpDeps {
  /** Absolute path to the extension-owned ingest DB. */
  ingestDbPath: string;
  /** Port to listen on (0 = ephemeral; the real port is returned by {@link start}). */
  port: number;
  /** Fired (debounced) after spans are ingested — wire to refresh + notifier.scan. */
  onIngest: () => void;
  /** Wall-clock now, injectable for tests. Defaults to `Date.now`. */
  now?: () => number;
  debounceMs?: number;
  pruneMaxAgeMs?: number;
  onError?: (err: unknown) => void;
}

export class LiveOtlpService {
  private store: IngestStore | undefined;
  private receiver: OtlpReceiver | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private pending = false;

  constructor(private readonly deps: LiveOtlpDeps) {}

  /** The ingest DB path (give this to `TelemetryService.setIngestDbPath`). */
  get dbPath(): string {
    return this.deps.ingestDbPath;
  }

  /** Open the store + start the receiver. Resolves with the actual bound port. */
  async start(): Promise<number> {
    const now = this.deps.now ?? Date.now;
    mkdirSync(dirname(this.deps.ingestDbPath), { recursive: true });
    this.store = new IngestStore(this.deps.ingestDbPath);
    try {
      this.store.prune(this.deps.pruneMaxAgeMs ?? DEFAULT_PRUNE_MS, now());
    } catch (err) {
      this.deps.onError?.(err);
    }
    this.receiver = new OtlpReceiver({
      port: this.deps.port,
      onSpans: (rows) => this.onSpans(rows),
      onError: this.deps.onError,
    });
    return this.receiver.start();
  }

  stop(): void {
    if (this.flushTimer !== undefined) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.pending = false;
    this.receiver?.stop();
    this.receiver = undefined;
    this.store?.close();
    this.store = undefined;
  }

  private onSpans(rows: SpanRows): void {
    if (this.store === undefined) {
      return;
    }
    try {
      this.store.writeSpans(rows);
    } catch (err) {
      this.deps.onError?.(err);
      return;
    }
    this.scheduleFlush();
  }

  /** Coalesce bursts of spans into one `onIngest` per debounce window. */
  private scheduleFlush(): void {
    this.pending = true;
    if (this.flushTimer !== undefined) {
      return;
    }
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.pending) {
        this.pending = false;
        try {
          this.deps.onIngest();
        } catch (err) {
          this.deps.onError?.(err);
        }
      }
    }, this.deps.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }
}
