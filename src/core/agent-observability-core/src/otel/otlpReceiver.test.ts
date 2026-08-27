import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { request } from 'node:http';
import { decodeTraceRequest, OtlpReceiver } from './otlpReceiver';
import { SpanRows } from './otlpToRows';

const sv = (s: string) => ({ stringValue: s });
const iv = (n: number) => ({ intValue: String(n) });

const traceEnvelope = {
  resourceSpans: [
    {
      resource: { attributes: [{ key: 'session.id', value: sv('s1') }] },
      scopeSpans: [
        {
          spans: [
            {
              name: 'chat',
              spanId: 'c1',
              traceId: 't1',
              startTimeUnixNano: '1700000000000000000',
              endTimeUnixNano: '1700000001000000000',
              status: { code: 1 },
              attributes: [
                { key: 'gen_ai.operation.name', value: sv('chat') },
                { key: 'gen_ai.conversation.id', value: sv('conv1') },
                { key: 'gen_ai.usage.input_tokens', value: iv(10) },
              ],
            },
          ],
        },
      ],
    },
  ],
};
const bodyJson = Buffer.from(JSON.stringify(traceEnvelope), 'utf8');

describe('decodeTraceRequest', () => {
  it('decodes a plain JSON OTLP traces body to rows', () => {
    const rows = decodeTraceRequest(bodyJson);
    expect(rows.spans).toHaveLength(1);
    expect(rows.spans[0].operation_name).toBe('chat');
    expect(rows.spans[0].conversation_id).toBe('conv1');
  });

  it('decodes a gzipped body', () => {
    const rows = decodeTraceRequest(gzipSync(bodyJson), 'gzip');
    expect(rows.spans).toHaveLength(1);
    expect(rows.spans[0].span_id).toBe('c1');
  });

  it('returns empty rows for a non-JSON body instead of throwing', () => {
    expect(decodeTraceRequest(Buffer.from('not json')).spans).toHaveLength(0);
  });
});

function post(port: number, path: string, body: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

/** Open a raw `/events` subscription and collect everything the server pushes. */
function openEvents(port: number): Promise<{ chunks: string[]; req: ReturnType<typeof request> }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path: '/events', method: 'GET' },
      (res) => {
        res.setEncoding('utf8');
        const chunks: string[] = [];
        res.on('data', (c: string) => chunks.push(c));
        resolve({ chunks, req });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Poll `check` until it holds (or fail after `timeoutMs`). */
async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('OtlpReceiver (real HTTP on 127.0.0.1)', () => {
  it('routes /v1/traces to onSpans and acks 200; ignores /v1/metrics', async () => {
    const received: SpanRows[] = [];
    const receiver = new OtlpReceiver({ port: 0, onSpans: (r) => received.push(r) });
    const port = await receiver.start();
    try {
      const tracesStatus = await post(port, '/v1/traces', bodyJson);
      const metricsStatus = await post(port, '/v1/metrics', Buffer.from('{"resourceMetrics":[]}'));
      expect(tracesStatus).toBe(200);
      expect(metricsStatus).toBe(200);
      expect(received).toHaveLength(1); // only /v1/traces produced spans
      expect(received[0].spans[0].operation_name).toBe('chat');
    } finally {
      receiver.stop();
    }
  });

  it('serves /events as SSE: hello (with identity) first, broadcast() pushes events', async () => {
    const receiver = new OtlpReceiver({
      port: 0,
      hello: { service: 'test-svc', ingestDbPath: 'x' },
      onSpans: () => {},
    });
    const port = await receiver.start();
    try {
      const { chunks } = await openEvents(port);
      await waitFor(() => chunks.join('').includes('event: hello'));
      expect(chunks.join('')).toContain('"service":"test-svc"');
      receiver.broadcast();
      receiver.broadcast();
      await waitFor(() => chunks.join('').split('\n\n').filter((f) => f.trim().length > 0).length >= 3);
    } finally {
      receiver.stop();
    }
  });

  it('stop() frees the port even while /events subscribers are connected', async () => {
    const first = new OtlpReceiver({ port: 0, onSpans: () => {} });
    const port = await first.start();
    await openEvents(port); // an open SSE response would pin the socket past close()
    first.stop();

    // Takeover depends on an immediate rebind; retry briefly to absorb the close.
    const second = new OtlpReceiver({ port, onSpans: () => {} });
    const deadline = Date.now() + 2000;
    for (;;) {
      try {
        expect(await second.start()).toBe(port);
        break;
      } catch (err) {
        if (Date.now() > deadline) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    }
    second.stop();
  });
});
