import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { gunzipSync, inflateSync } from 'node:zlib';
import { flattenSpans } from './otlpParse';
import { otlpSpansToRows, SpanRows } from './otlpToRows';

/**
 * Localhost OTLP/HTTP receiver — the real-time push source.
 *
 * Copilot's `otlp-http` exporter POSTs OTLP/JSON to `/v1/traces` (also `/v1/logs`,
 * `/v1/metrics`, which we acknowledge and ignore). We decode the traces, map them
 * to Copilot-schema rows ({@link otlpSpansToRows}) and hand them to `onSpans`.
 * Bound to 127.0.0.1 ONLY — never exposed to the network; the enable command sets
 * Copilot's endpoint to an explicit `http://127.0.0.1:<port>` so loopback is exact.
 *
 * The same server also serves `GET /events`, a Server-Sent-Events stream for the
 * OTHER VS Code windows: the port is a user-level setting shared by every window,
 * so only one window can own this receiver — the rest subscribe here and are
 * pinged by {@link OtlpReceiver.broadcast} after each persisted batch (see
 * {@link ./liveOtlpService.LiveOtlpService} for the election). The stream opens
 * with a `hello` event carrying {@link OtlpReceiverOptions.hello} so a subscriber
 * can tell our receiver apart from an unrelated process squatting the port.
 */

/** Guard against an absurd body (real exports are KBs–low MBs). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * Decode one OTLP `/v1/traces` request body into Copilot-schema rows. Pure:
 * handles gzip/deflate, parses OTLP/JSON, flattens to spans, maps to rows. A
 * non-JSON or unparseable body yields empty rows rather than throwing.
 */
export function decodeTraceRequest(body: Buffer, contentEncoding?: string): SpanRows {
  let buf = body;
  const enc = (contentEncoding ?? '').toLowerCase();
  try {
    if (enc.includes('gzip')) {
      buf = gunzipSync(body);
    } else if (enc.includes('deflate')) {
      buf = inflateSync(body);
    }
  } catch {
    return { spans: [], attributes: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch {
    return { spans: [], attributes: [] };
  }
  return otlpSpansToRows(flattenSpans(parsed));
}

export interface OtlpReceiverOptions {
  /** Port to listen on; `0` picks an ephemeral free port (returned by {@link start}). */
  port: number;
  /** Called with the decoded rows of each `/v1/traces` request (never empty). */
  onSpans: (rows: SpanRows) => void;
  /**
   * JSON payload of the `hello` event opening each `/events` subscription —
   * the receiver's identity, so a subscriber can verify the port is ours.
   */
  hello?: unknown;
  /** Optional error sink (decode/socket errors); the request is still acked 200. */
  onError?: (err: unknown) => void;
}

export class OtlpReceiver {
  private server: Server | undefined;
  private readonly subscribers = new Set<ServerResponse>();

  constructor(private readonly opts: OtlpReceiverOptions) {}

  /** Start listening on 127.0.0.1. Resolves with the actual bound port. */
  start(): Promise<number> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => this.handle(req, res));
      server.once('error', (err) => {
        this.server = undefined;
        reject(err);
      });
      server.listen(this.opts.port, '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        resolve(typeof addr === 'object' && addr !== null ? addr.port : this.opts.port);
      });
    });
  }

  stop(): void {
    for (const res of this.subscribers) {
      res.destroy();
    }
    this.subscribers.clear();
    this.server?.close();
    // Open SSE responses and idle keep-alive sockets would otherwise hold the
    // port bound after close(); takeover by another window depends on the port
    // freeing the moment this receiver stops.
    this.server?.closeAllConnections();
    this.server = undefined;
  }

  /** Ping every `/events` subscriber: "a batch was persisted — re-read the DB". */
  broadcast(): void {
    for (const res of this.subscribers) {
      res.write('data: {}\n\n');
    }
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '';
    if (req.method === 'GET' && /\/events\/?$/.test(url)) {
      this.subscribe(res);
      return;
    }
    const isTraces = req.method === 'POST' && /\/v1\/traces\/?$/.test(url);
    const chunks: Buffer[] = [];
    let size = 0;
    let tooBig = false;

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (err) => this.opts.onError?.(err));
    req.on('end', () => {
      if (isTraces && !tooBig) {
        try {
          const encoding = req.headers['content-encoding'];
          const rows = decodeTraceRequest(
            Buffer.concat(chunks),
            typeof encoding === 'string' ? encoding : undefined,
          );
          if (rows.spans.length > 0) {
            this.opts.onSpans(rows);
          }
        } catch (err) {
          this.opts.onError?.(err);
        }
      }
      // Always ack 200 so the exporter never errors/retries (logs/metrics included).
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  }

  /** `GET /events`: open a never-ending SSE response, `hello` first. */
  private subscribe(res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    res.write(`event: hello\ndata: ${JSON.stringify(this.opts.hello ?? {})}\n\n`);
    this.subscribers.add(res);
    res.on('close', () => this.subscribers.delete(res));
    res.on('error', (err) => {
      this.subscribers.delete(res);
      this.opts.onError?.(err);
    });
  }
}
