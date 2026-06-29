import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LiveSource } from '../live/liveSource';
import { IngestStore } from './ingestStore';
import { OtlpReceiver } from './otlpReceiver';
import { SpanRows } from './otlpToRows';

/**
 * Owns the live-OTLP pipeline: the {@link OtlpReceiver} (localhost push source)
 * and the {@link IngestStore} (the extension's own Copilot-schema DB the rest of
 * the stack reads). Each `/v1/traces` batch is written immediately, then `signal`
 * is fired so the shared {@link ../live/liveUpdateController.LiveUpdateController}
 * coalesces the burst into one debounced refresh.
 *
 * Implements {@link LiveSource} so it plugs into the controller alongside the
 * Claude transcript watcher. Vscode-free (the extension supplies the storage
 * path, port, and the signal), so it is unit-testable headless.
 */

const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60_000; // keep ~7 days so the snapshot stays small

export interface LiveOtlpDeps {
  /** Absolute path to the extension-owned ingest DB. */
  ingestDbPath: string;
  /** Port to listen on (0 = ephemeral; the real port is reported via onListening). */
  port: number;
  /** Fired after a span batch is ingested — wire to `controller.signal`. */
  signal: () => void;
  /** Called once with the actually-bound port when the receiver is listening. */
  onListening?: (port: number) => void;
  /** Bind failure (e.g. port in use) — surface to the user; the source stays inert. */
  onStartError?: (err: unknown) => void;
  pruneMaxAgeMs?: number;
  /** Runtime errors (decode/socket/prune) — log only; never user-facing. */
  onError?: (err: unknown) => void;
}

export class LiveOtlpService implements LiveSource {
  readonly label = 'Copilot OTLP receiver';

  private store: IngestStore | undefined;
  private receiver: OtlpReceiver | undefined;

  constructor(private readonly deps: LiveOtlpDeps) {}

  /** The ingest DB path (give this to `TelemetryService.setIngestDbPath`). */
  get dbPath(): string {
    return this.deps.ingestDbPath;
  }

  /**
   * Open the store + start the receiver. On a successful bind, reports the port
   * via {@link LiveOtlpDeps.onListening}; on a bind failure, reports via
   * {@link LiveOtlpDeps.onError} and resolves inert (so it never breaks the other
   * live sources).
   */
  async start(): Promise<void> {
    mkdirSync(dirname(this.deps.ingestDbPath), { recursive: true });
    this.store = new IngestStore(this.deps.ingestDbPath);
    try {
      this.store.prune(this.deps.pruneMaxAgeMs ?? DEFAULT_PRUNE_MS, Date.now());
    } catch (err) {
      this.deps.onError?.(err);
    }
    this.receiver = new OtlpReceiver({
      port: this.deps.port,
      onSpans: (rows) => this.onSpans(rows),
      onError: this.deps.onError,
    });
    try {
      const boundPort = await this.receiver.start();
      this.deps.onListening?.(boundPort);
    } catch (err) {
      this.deps.onStartError?.(err);
    }
  }

  stop(): void {
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
    this.deps.signal();
  }
}
