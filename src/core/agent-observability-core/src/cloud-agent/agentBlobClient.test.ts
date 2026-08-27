import { describe, it, expect } from 'vitest';
import type { HttpPoster, HttpResponse } from '../sync/httpPoster';
import { AgentBlobClient } from './agentBlobClient';

/** A fake transport that records the last GET and returns a canned response. */
class FakeHttp implements HttpPoster {
  lastUrl?: string;
  lastHeaders?: Record<string, string>;
  getCalls = 0;
  constructor(private readonly responder: (url: string) => HttpResponse | Error) {}
  post(): Promise<HttpResponse> {
    throw new Error('post not used');
  }
  get(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    this.getCalls++;
    this.lastUrl = url;
    this.lastHeaders = headers;
    const r = this.responder(url);
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}

const ok = (body: string): HttpResponse => ({ status: 200, body });
const status = (code: number): HttpResponse => ({ status: code, body: '' });

function client(
  http: HttpPoster,
  opts: { token?: string | undefined } = { token: 'secret' },
  endpoint = 'https://relay.example/base/',
) {
  return new AgentBlobClient({ http, endpoint, getToken: () => Promise.resolve(opts.token) });
}

describe('AgentBlobClient.listBatches', () => {
  it('requests the batches path with since+limit and a bearer header', async () => {
    const http = new FakeHttp(() => ok('[]'));
    const res = await client(http).listBatches(1234, 50);
    expect(res.ok).toBe(true);
    expect(http.lastUrl).toBe('https://relay.example/base/agent-otlp/batches?since=1234&limit=50');
    expect(http.lastHeaders?.Authorization).toBe('Bearer secret');
  });

  it('parses an array of refs, newest-first, capped to max', async () => {
    const body = JSON.stringify([
      { id: 'a', service: 'svc', createdAtMs: 100 },
      { id: 'b', service: 'svc', createdAtMs: 300 },
      { id: 'c', service: 'svc', createdAtMs: 200 },
    ]);
    const res = await client(new FakeHttp(() => ok(body))).listBatches(0, 2);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.map((r) => r.id)).toEqual(['b', 'c']);
    }
  });

  it('accepts a { batches: [...] } envelope and skips malformed entries', async () => {
    const body = JSON.stringify({
      batches: [
        { id: 'good', service: 'svc', createdAtMs: 10 },
        { service: 'no-id', createdAtMs: 20 },
        null,
        42,
        { id: '', createdAtMs: 30 },
      ],
    });
    const res = await client(new FakeHttp(() => ok(body))).listBatches(0, 10);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.map((r) => r.id)).toEqual(['good']);
      expect(res.value[0].service).toBe('svc');
    }
  });

  it('returns unauthenticated WITHOUT a request when no token is set', async () => {
    const http = new FakeHttp(() => ok('[]'));
    const res = await client(http, { token: undefined }).listBatches(0, 10);
    expect(res).toMatchObject({ ok: false, reason: 'unauthenticated' });
    expect(http.getCalls).toBe(0);
  });

  it('maps HTTP status codes to failure reasons', async () => {
    const cases: Array<[number, string]> = [
      [401, 'unauthenticated'],
      [403, 'unauthenticated'],
      [404, 'featureUnavailable'],
      [429, 'rateLimited'],
      [500, 'error'],
    ];
    for (const [code, reason] of cases) {
      const res = await client(new FakeHttp(() => status(code))).listBatches(0, 10);
      expect(res).toMatchObject({ ok: false, reason });
    }
  });

  it('maps a thrown transport error to a network failure', async () => {
    const err = Object.assign(new Error('down'), { code: 'ECONNREFUSED' });
    const res = await client(new FakeHttp(() => err)).listBatches(0, 10);
    expect(res).toMatchObject({ ok: false, reason: 'network' });
    if (!res.ok) {
      expect(res.message).toContain('ECONNREFUSED');
    }
  });
});

describe('AgentBlobClient.downloadBatch', () => {
  it('returns the raw body verbatim and encodes the id in the path', async () => {
    const raw = '{"resourceSpans":[{"scopeSpans":[]}]}';
    const http = new FakeHttp(() => ok(raw));
    const res = await client(http).downloadBatch({ id: 'a/b c', service: 'svc', createdAtMs: 1 });
    expect(res).toEqual({ ok: true, value: raw });
    expect(http.lastUrl).toBe('https://relay.example/base/agent-otlp/batches/a%2Fb%20c');
  });

  it('returns unauthenticated without a request when no token is set', async () => {
    const http = new FakeHttp(() => ok('{}'));
    const res = await client(http, { token: undefined }).downloadBatch({ id: 'x', service: 's', createdAtMs: 1 });
    expect(res).toMatchObject({ ok: false, reason: 'unauthenticated' });
    expect(http.getCalls).toBe(0);
  });
});
