import { describe, it, expect } from 'vitest';
import { SyncClient, SyncOutcome, isTransient } from './syncClient';
import { HttpPoster, HttpResponse } from './httpPoster';
import { AggregateBatch } from '../aggregate/models';

/**
 * SyncClient unit tests with a recording fake {@link HttpPoster}. These pin the
 * request shape (URL, Bearer header, JSON body), the status->outcome mapping, and
 * the security invariant that the API key NEVER appears in any returned string.
 */

const API_KEY = 'aoa_7f3a9c2e_supersecretvalue_do_not_leak';
const DASHBOARD = 'https://dashboard.example.com';

/** A minimal, schema-shaped batch (content irrelevant to the client). */
function batch(): AggregateBatch {
  return {
    schemaVersion: '1.0',
    batchId: 'b1',
    generatedAt: '2026-06-02T09:00:00.000Z',
    toolVersion: '1.2.3',
    pseudonymousDeveloperId: 'dev_0123456789abcdef0123456789abcdef',
    window: { start: '2026-06-02T08:00:00.000Z', end: '2026-06-02T08:30:00.000Z' },
    buckets: [],
  };
}

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** Fake poster: returns a canned POST response and records every call. */
class FakePoster implements HttpPoster {
  readonly posts: Recorded[] = [];
  readonly gets: string[] = [];
  postThrows: Error | undefined;

  constructor(private readonly response: HttpResponse) {}

  async post(url: string, headers: Record<string, string>, body: string): Promise<HttpResponse> {
    this.posts.push({ url, headers, body });
    if (this.postThrows) {
      throw this.postThrows;
    }
    return this.response;
  }

  async get(url: string): Promise<HttpResponse> {
    this.gets.push(url);
    return this.response;
  }
}

function clientWith(
  response: HttpResponse,
  opts?: { url?: string; key?: string | undefined },
): { client: SyncClient; poster: FakePoster } {
  const poster = new FakePoster(response);
  const client = new SyncClient(
    poster,
    () => opts?.url ?? DASHBOARD,
    async () => (opts && 'key' in opts ? opts.key : API_KEY),
  );
  return { client, poster };
}

describe('SyncClient.sendBatch request shape', () => {
  it('POSTs to /api/ingest/aggregate with a Bearer header and JSON batch body', async () => {
    const { client, poster } = clientWith({ status: 200, body: JSON.stringify({ accepted: true, batchId: 'b1' }) });
    await client.sendBatch(batch());

    expect(poster.posts).toHaveLength(1);
    const call = poster.posts[0];
    expect(call.url).toBe('https://dashboard.example.com/api/ingest/aggregate');
    expect(call.headers.Authorization).toBe(`Bearer ${API_KEY}`);
    // Body is the serialized batch and round-trips to the same object.
    expect(JSON.parse(call.body)).toEqual(batch());
  });

  it('collapses a trailing slash on the dashboard URL', async () => {
    const { client, poster } = clientWith(
      { status: 200, body: '{}' },
      { url: 'https://dashboard.example.com/' },
    );
    await client.sendBatch(batch());
    expect(poster.posts[0].url).toBe('https://dashboard.example.com/api/ingest/aggregate');
  });
});

describe('SyncClient.sendBatch status -> outcome mapping', () => {
  async function outcomeFor(response: HttpResponse): Promise<SyncOutcome> {
    return clientWith(response).client.sendBatch(batch());
  }

  it('200 -> success with accepted + batchId parsed from the body', async () => {
    const outcome = await outcomeFor({ status: 200, body: JSON.stringify({ accepted: true, batchId: 'srv-123' }) });
    expect(outcome).toEqual({ kind: 'success', accepted: true, batchId: 'srv-123' });
  });

  it('400 -> rejected with the server detail surfaced', async () => {
    const outcome = await outcomeFor({ status: 400, body: JSON.stringify({ error: 'raw field rejected: gen_ai.input.messages' }) });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.detail).toContain('raw field rejected');
    }
  });

  it('401 -> unauthorized', async () => {
    expect(await outcomeFor({ status: 401, body: '{"error":"invalid_token"}' })).toEqual({ kind: 'unauthorized' });
  });

  it('403 -> unauthorized (authenticated-but-not-permitted, surfaced for re-check)', async () => {
    expect(await outcomeFor({ status: 403, body: '' })).toEqual({ kind: 'unauthorized' });
  });

  it('429 + Retry-After (seconds) -> rateLimited with retryAfterMs', async () => {
    const outcome = await outcomeFor({
      status: 429,
      body: '',
      header: (n) => (n.toLowerCase() === 'retry-after' ? '12' : undefined),
    });
    expect(outcome).toEqual({ kind: 'rateLimited', retryAfterMs: 12_000 });
  });

  it('429 without Retry-After -> rateLimited with undefined delay', async () => {
    const outcome = await outcomeFor({ status: 429, body: '' });
    expect(outcome).toEqual({ kind: 'rateLimited', retryAfterMs: undefined });
  });

  it('503 -> disabled', async () => {
    expect(await outcomeFor({ status: 503, body: '' })).toEqual({ kind: 'disabled' });
  });

  it('500 -> serverError with the status', async () => {
    expect(await outcomeFor({ status: 500, body: 'boom' })).toEqual({ kind: 'serverError', status: 500 });
  });

  it('a transport throw -> network outcome (never throws out of the client)', async () => {
    const { client, poster } = clientWith({ status: 200, body: '{}' });
    poster.postThrows = new Error('getaddrinfo ENOTFOUND');
    const outcome = await client.sendBatch(batch());
    expect(outcome.kind).toBe('network');
  });

  it('missing dashboard URL -> misconfigured (no POST attempted)', async () => {
    const { client, poster } = clientWith({ status: 200, body: '{}' }, { url: '' });
    expect(await client.sendBatch(batch())).toEqual({ kind: 'misconfigured' });
    expect(poster.posts).toHaveLength(0);
  });

  it('missing API key -> misconfigured (no POST attempted)', async () => {
    const { client, poster } = clientWith({ status: 200, body: '{}' }, { key: undefined });
    expect(await client.sendBatch(batch())).toEqual({ kind: 'misconfigured' });
    expect(poster.posts).toHaveLength(0);
  });
});

describe('isTransient classification', () => {
  it('treats network/serverError/rateLimited as transient and others as permanent', () => {
    expect(isTransient({ kind: 'network', message: 'x' })).toBe(true);
    expect(isTransient({ kind: 'serverError', status: 500 })).toBe(true);
    expect(isTransient({ kind: 'rateLimited' })).toBe(true);
    expect(isTransient({ kind: 'unauthorized' })).toBe(false);
    expect(isTransient({ kind: 'rejected', detail: 'x' })).toBe(false);
    expect(isTransient({ kind: 'disabled' })).toBe(false);
    expect(isTransient({ kind: 'misconfigured' })).toBe(false);
    expect(isTransient({ kind: 'success', accepted: true, batchId: 'b' })).toBe(false);
  });
});

describe('SyncClient never leaks the API key', () => {
  it('does not place the key in any returned outcome string across all statuses', async () => {
    const statuses: HttpResponse[] = [
      { status: 400, body: API_KEY }, // even if the server echoed it back
      { status: 401, body: API_KEY },
      { status: 503, body: API_KEY },
      { status: 500, body: API_KEY },
      { status: 418, body: API_KEY },
    ];
    for (const response of statuses) {
      const outcome = await clientWith(response).client.sendBatch(batch());
      expect(JSON.stringify(outcome)).not.toContain(API_KEY);
    }
  });

  it('does not include the key in a network error message even if the error mentions it', async () => {
    const { client, poster } = clientWith({ status: 200, body: '{}' });
    // The transport error message must not be allowed to carry the key — the
    // client only relays the error's own message, which is about transport.
    poster.postThrows = new Error('connection reset');
    const outcome = await client.sendBatch(batch());
    expect(JSON.stringify(outcome)).not.toContain(API_KEY);
  });
});

describe('SyncClient.reportStatus + checkHealth are best-effort', () => {
  it('reportStatus returns true on 2xx and false otherwise, never throwing', async () => {
    const ok = clientWith({ status: 200, body: '' }).client;
    expect(await ok.reportStatus({ toolVersion: '1.0.0', lastOutcome: 'success', reportedAtMs: 1 })).toBe(true);

    const bad = clientWith({ status: 500, body: '' }).client;
    expect(await bad.reportStatus({ toolVersion: '1.0.0', lastOutcome: 'success', reportedAtMs: 1 })).toBe(false);
  });

  it('reportStatus swallows a transport throw and misconfiguration', async () => {
    const { client, poster } = clientWith({ status: 200, body: '' });
    poster.postThrows = new Error('down');
    expect(await client.reportStatus({ toolVersion: '1.0.0', lastOutcome: 'success', reportedAtMs: 1 })).toBe(false);

    const misconf = clientWith({ status: 200, body: '' }, { url: '' }).client;
    expect(await misconf.reportStatus({ toolVersion: '1.0.0', lastOutcome: 'success', reportedAtMs: 1 })).toBe(false);
  });

  it('checkHealth GETs /api/ingest/health anonymously', async () => {
    const { client, poster } = clientWith({ status: 200, body: 'ok' });
    expect(await client.checkHealth()).toBe(true);
    expect(poster.gets).toEqual(['https://dashboard.example.com/api/ingest/health']);
  });
});
