import { get } from 'node:http';
import type { ClientRequest, IncomingMessage } from 'node:http';

/**
 * Minimal Server-Sent-Events client for the OTLP receiver's `/events` endpoint.
 *
 * A READER window — one that lost the shared-port election to another VS Code
 * window's receiver (see {@link ./liveOtlpService.LiveOtlpService}) — holds this
 * connection open. Each pushed event means "the shared ingest DB changed:
 * re-read it"; the connection dropping means the receiver window is gone, which
 * is the reader's cue to race for the port itself. Transport only: it parses
 * the paired receiver's framing (LF-delimited, `hello` first), not general SSE.
 */

export interface EventStreamCloseReason {
  /**
   * The endpoint answered but is NOT our event stream (wrong status or
   * content-type, or its first event was not `hello`) — some other process owns
   * the port. Reconnecting is pointless; the caller should surface a port
   * conflict instead of retrying.
   */
  foreign: boolean;
  /** The underlying socket/HTTP error, when one caused the close. */
  error?: unknown;
}

export interface EventStreamClientOptions {
  /** Port on 127.0.0.1 to subscribe to (the shared live-updates port). */
  port: number;
  /** How long to wait for `hello` before declaring the endpoint foreign. */
  helloTimeoutMs?: number;
  /** First event: the receiver's identity payload (parsed JSON, or undefined). */
  onHello: (data: unknown) => void;
  /** Every event after `hello` — "something changed". */
  onEvent: () => void;
  /** Fired exactly once when the connection is over (including via {@link close}). */
  onClose: (reason: EventStreamCloseReason) => void;
}

const DEFAULT_HELLO_TIMEOUT_MS = 3_000;

/** Cap on unframed buffered bytes — a stream that never frames is not ours. */
const MAX_BUFFER_BYTES = 64 * 1024;

export class EventStreamClient {
  private req: ClientRequest | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private buffer = '';
  private sawHello = false;
  private closed = false;

  constructor(private readonly opts: EventStreamClientOptions) {}

  connect(): void {
    const req = get(
      {
        host: '127.0.0.1',
        port: this.opts.port,
        path: '/events',
        headers: { accept: 'text/event-stream' },
      },
      (res) => this.onResponse(res),
    );
    this.req = req;
    req.on('error', (err) => this.finish({ foreign: false, error: err }));
    this.helloTimer = setTimeout(
      () => this.finish({ foreign: true, error: new Error('no hello event') }),
      this.opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
    );
  }

  /** Tear the connection down; `onClose` still fires (once). */
  close(): void {
    this.finish({ foreign: false });
  }

  private onResponse(res: IncomingMessage): void {
    const contentType = res.headers['content-type'] ?? '';
    if (res.statusCode !== 200 || !contentType.includes('text/event-stream')) {
      this.finish({ foreign: true });
      return;
    }
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => this.onData(chunk));
    res.on('end', () => this.finish({ foreign: false }));
    res.on('error', (err) => this.finish({ foreign: false, error: err }));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while (!this.closed && (idx = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.onFrame(frame);
    }
    if (!this.closed && this.buffer.length > MAX_BUFFER_BYTES) {
      this.finish({ foreign: true });
    }
  }

  private onFrame(frame: string): void {
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).trim());
      }
    }
    if (!this.sawHello) {
      // Anything speaking event-stream but not opening with our hello is foreign.
      if (event !== 'hello') {
        this.finish({ foreign: true });
        return;
      }
      this.sawHello = true;
      if (this.helloTimer !== undefined) {
        clearTimeout(this.helloTimer);
        this.helloTimer = undefined;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(dataLines.join('\n'));
      } catch {
        payload = undefined;
      }
      this.opts.onHello(payload);
      return;
    }
    if (dataLines.length > 0) {
      this.opts.onEvent();
    }
  }

  private finish(reason: EventStreamCloseReason): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.helloTimer !== undefined) {
      clearTimeout(this.helloTimer);
      this.helloTimer = undefined;
    }
    this.req?.destroy();
    this.req = undefined;
    this.opts.onClose(reason);
  }
}
