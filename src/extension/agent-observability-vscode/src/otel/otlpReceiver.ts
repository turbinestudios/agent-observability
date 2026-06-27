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
  /** Optional error sink (decode/socket errors); the request is still acked 200. */
  onError?: (err: unknown) => void;
}

export class OtlpReceiver {
  private server: Server | undefined;

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
    this.server?.close();
    this.server = undefined;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = req.url ?? '';
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
}
