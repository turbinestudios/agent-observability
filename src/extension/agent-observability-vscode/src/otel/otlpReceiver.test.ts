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
});
