import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { LiveSource } from '../live/liveSource';
import { IngestStore } from './ingestStore';
import { OtlpReceiver } from './otlpReceiver';
import { SpanRows } from './otlpToRows';
import { EventStreamClient } from './sseClient';

/**
 * Owns the live-OTLP pipeline. The port AND the ingest DB are shared by every
 * VS Code window (user-level setting + globalStorage), and both admit only ONE
 * owner — Copilot exports to a single endpoint, and the {@link IngestStore} is
 * single-writer — so each window's service runs an election on `start()`:
 *
 * - Bind won → **receiver**: run the {@link OtlpReceiver}, open the store, write
 *   each `/v1/traces` batch, then fire `signal` locally and
 *   {@link OtlpReceiver.broadcast} to every reader (persist-then-notify, so a
 *   woken reader always finds the rows).
 * - Bind lost (`EADDRINUSE`) → **reader**: never touch the store; subscribe to
 *   the winner's `/events` stream and translate its pings into `signal` calls.
 *   The stream dropping means the receiver window closed: retry the bind (with
 *   jittered backoff, so concurrent readers spread out) and either get promoted
 *   or re-subscribe to whichever window won.
 *
 * The `hello` event opening `/events` carries the receiver's identity; a port
 * owner that is not one of ours — or one writing a DIFFERENT ingest DB (another
 * VS Code profile) — is a real conflict, reported once via `onStartError`.
 *
 * Implements {@link LiveSource} so it plugs into the controller alongside the
 * Claude transcript watcher. Vscode-free (the extension supplies the storage
 * path, port, and the signal), so it is unit-testable headless.
 */

const DEFAULT_PRUNE_MS = 7 * 24 * 60 * 60_000; // keep ~7 days so the snapshot stays small

/** Identity announced in the `/events` hello (checked by reader windows). */
const HELLO_SERVICE = 'agent-observability-otlp';

/** First re-election attempt lands ~100–300 ms after the stream drops … */
const RETRY_BASE_MS = 200;
/** … and repeated failures settle into a slow probe. */
const RETRY_MAX_MS = 15_000;

export interface LiveOtlpDeps {
  /** Absolute path to the extension-owned ingest DB. */
  ingestDbPath: string;
  /** Port to listen on (0 = ephemeral; the real port is reported via onListening). */
  port: number;
  /** Fired after a span batch is ingested — wire to `controller.signal`. */
  signal: () => void;
  /** Called with the actually-bound port whenever this window IS the receiver. */
  onListening?: (port: number) => void;
  /**
   * Called once when this window settles in as a READER: another window's
   * receiver owns the port and this one follows its `/events` stream. The
   * shared ingest DB is still the right source to attach.
   */
  onReading?: () => void;
  /**
   * Unrecoverable startup conflict — an unexpected bind error, or the port is
   * owned by a process that is not (our) receiver. NOT fired for `EADDRINUSE`
   * against a sibling window; that is the normal reader path.
   */
  onStartError?: (err: unknown) => void;
  pruneMaxAgeMs?: number;
  /** Runtime errors (decode/socket/prune) — log only; never user-facing. */
  onError?: (err: unknown) => void;
}

export class LiveOtlpService implements LiveSource {
  readonly label = 'Copilot OTLP receiver';

  private store: IngestStore | undefined;
  private receiver: OtlpReceiver | undefined;
  private client: EventStreamClient | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Consecutive bind→subscribe cycles without landing a role (drives backoff). */
  private failedCycles = 0;
  private announcedReader = false;
  /** Genuine port conflict reported — stay inert instead of retrying forever. */
  private inert = false;
  private stopped = false;

  constructor(private readonly deps: LiveOtlpDeps) {}

  /** The ingest DB path (give this to `TelemetryService.setIngestDbPath`). */
  get dbPath(): string {
    return this.deps.ingestDbPath;
  }

  /** Run the election: resolve as receiver, reader, or (on conflict) inert. */
  async start(): Promise<void> {
    mkdirSync(dirname(this.deps.ingestDbPath), { recursive: true });
    await this.tryBecomeReceiver();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer !== undefined) {
      clearTimeout(this.retryTimer);
      this.retryTimer = undefined;
    }
    this.client?.close();
    this.client = undefined;
    this.receiver?.stop();
    this.receiver = undefined;
    this.store?.close();
    this.store = undefined;
  }

  private async tryBecomeReceiver(): Promise<void> {
    if (this.stopped || this.inert) {
      return;
    }
    const receiver = new OtlpReceiver({
      port: this.deps.port,
      hello: { service: HELLO_SERVICE, ingestDbPath: this.deps.ingestDbPath },
      onSpans: (rows) => this.onSpans(rows),
      onError: this.deps.onError,
    });
    let boundPort: number;
    try {
      boundPort = await receiver.start();
    } catch (err) {
      if (this.stopped) {
        return;
      }
      if ((err as NodeJS.ErrnoException | null)?.code === 'EADDRINUSE') {
        this.becomeReader();
      } else {
        this.deps.onStartError?.(err);
      }
      return;
    }
    if (this.stopped) {
      receiver.stop();
      return;
    }
    this.receiver = receiver;
    this.failedCycles = 0;
    // The store opens only AFTER winning the election — it is single-writer.
    this.store = new IngestStore(this.deps.ingestDbPath);
    try {
      this.store.prune(this.deps.pruneMaxAgeMs ?? DEFAULT_PRUNE_MS, Date.now());
    } catch (err) {
      this.deps.onError?.(err);
    }
    this.deps.onListening?.(boundPort);
  }

  private becomeReader(): void {
    const client = new EventStreamClient({
      port: this.deps.port,
      onHello: (data) => this.onHello(data),
      onEvent: () => this.deps.signal(),
      onClose: (reason) => {
        if (this.client === client) {
          this.client = undefined;
        }
        if (this.stopped || this.inert) {
          return;
        }
        if (reason.foreign) {
          this.giveUp(
            new Error(
              `port ${this.deps.port} is in use by another process that is not an Agent Observability receiver`,
            ),
          );
          return;
        }
        // The receiver window is gone (or the connect raced a hand-over): race
        // for the port; a loser simply re-enters here as a reader again.
        this.scheduleRetry();
      },
    });
    this.client = client;
    client.connect();
  }

  /** Reader-side identity check on the receiver that answered. */
  private onHello(data: unknown): void {
    const hello = (typeof data === 'object' && data !== null ? data : {}) as {
      service?: unknown;
      ingestDbPath?: unknown;
    };
    if (hello.service !== HELLO_SERVICE) {
      this.giveUp(
        new Error(`port ${this.deps.port} answered, but not as an Agent Observability receiver`),
      );
      return;
    }
    if (typeof hello.ingestDbPath === 'string' && hello.ingestDbPath !== this.deps.ingestDbPath) {
      // A receiver from a different VS Code profile/installation: it writes a
      // different ingest DB, so following its pings would render foreign data.
      this.giveUp(
        new Error(
          `port ${this.deps.port} is owned by an Agent Observability receiver ` +
            `writing a different ingest DB (${hello.ingestDbPath})`,
        ),
      );
      return;
    }
    this.failedCycles = 0;
    if (!this.announcedReader) {
      this.announcedReader = true;
      this.deps.onReading?.();
    }
    // Catch-up: batches may have been persisted while this window was not
    // subscribed (it just opened, or the stream was down during a hand-over).
    this.deps.signal();
  }

  private giveUp(err: Error): void {
    this.inert = true;
    this.client?.close();
    this.client = undefined;
    this.deps.onStartError?.(err);
  }

  private scheduleRetry(): void {
    this.failedCycles += 1;
    const backoff = Math.min(RETRY_BASE_MS * 2 ** (this.failedCycles - 1), RETRY_MAX_MS);
    // Jitter spreads sibling readers racing for the same freed port.
    const delayMs = Math.round(backoff * (0.5 + Math.random()));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.tryBecomeReceiver();
    }, delayMs);
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
    // Persist-then-notify: the rows are readable before anyone is woken.
    this.deps.signal();
    this.receiver?.broadcast();
  }
}
