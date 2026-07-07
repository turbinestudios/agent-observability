import { describe, it, expect } from 'vitest';
import { CloudApiClient } from './cloudApiClient';
import { CloudAccountAuth, CloudRepoRef, RawCloudTask } from './cloudTypes';
import { HttpPoster, HttpResponse } from '../sync/httpPoster';

/**
 * CloudApiClient unit tests with a recording, URL-keyed fake {@link HttpPoster}.
 * These pin the parse/sort/cap behavior of the list endpoint, the malformed-body
 * guards, the repo-id resolution + cache, the raw-body-verbatim CAPI logs fetch,
 * and the shared getJson status/parse/transport failure mapping. No disk, no
 * `vscode`, no real network — everything is injected via the constructor deps.
 */

const REST_BASE = 'https://api.github.com';
const CAPI_BASE = 'https://api.capi.example.com';
const TOKEN = 'gho_faketoken_do_not_leak';

/** A resolved per-account auth context, built inline (no gh shell-out). */
const AUTH: CloudAccountAuth = {
  login: 'octocat',
  token: TOKEN,
  capiBase: CAPI_BASE,
  userId: 42,
  source: 'gh',
};

interface Recorded {
  url: string;
  headers: Record<string, string> | undefined;
}

/**
 * Fake poster: records every (url, headers) and returns canned responses keyed
 * by URL. Register one response (reused on every hit) or several (dequeued in
 * order, last one sticks). A registered `getThrows` makes the next GET reject to
 * exercise the transport-error path.
 */
class FakePoster implements HttpPoster {
  readonly gets: Recorded[] = [];
  readonly posts: Recorded[] = [];
  getThrows: Error | undefined;
  private readonly responses = new Map<string, HttpResponse[]>();

  /** Register one or more canned responses for `url`. */
  on(url: string, ...res: HttpResponse[]): this {
    this.responses.set(url, [...(this.responses.get(url) ?? []), ...res]);
    return this;
  }

  /** All GETs whose URL contains `needle`, in call order. */
  getsMatching(needle: string): Recorded[] {
    return this.gets.filter((g) => g.url.includes(needle));
  }

  async post(url: string, headers: Record<string, string>, _body: string): Promise<HttpResponse> {
    this.posts.push({ url, headers });
    return this.next(url);
  }

  async get(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    this.gets.push({ url, headers });
    if (this.getThrows) {
      throw this.getThrows;
    }
    return this.next(url);
  }

  private next(url: string): HttpResponse {
    const queue = this.responses.get(url);
    if (queue === undefined || queue.length === 0) {
      throw new Error(`FakePoster: no canned response registered for ${url}`);
    }
    return queue.length > 1 ? queue.shift()! : queue[0];
  }
}

function makeClient(): { client: CloudApiClient; poster: FakePoster } {
  const poster = new FakePoster();
  const client = new CloudApiClient({ http: poster });
  return { client, poster };
}

/** A 200 JSON response from an object/array value. */
function json(value: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify(value) };
}

describe('CloudApiClient.listMyTasks', () => {
  it('parses a bare-array body, sorts newest-first, and sends the auth + api-version headers', async () => {
    const { client, poster } = makeClient();
    const url = `${REST_BASE}/agents/tasks?per_page=10`;
    const tasks: RawCloudTask[] = [
      { id: 't-old', updated_at: '2026-07-01T00:00:00Z' },
      { id: 't-new', updated_at: '2026-07-05T00:00:00Z' },
      { id: 't-mid', updated_at: '2026-07-03T00:00:00Z' },
    ];
    poster.on(url, json(tasks));

    const res = await client.listMyTasks(AUTH, 10);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.map((t) => t.id)).toEqual(['t-new', 't-mid', 't-old']);
    }
    // Request shape: exactly one GET to the list URL, with the REST headers.
    expect(poster.gets).toHaveLength(1);
    expect(poster.gets[0].url).toBe(url);
    const headers = poster.gets[0].headers!;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['X-GitHub-Api-Version']).toBe('2026-03-10');
    expect(headers.Accept).toBe('application/vnd.github+json');
  });

  it('parses a { tasks: [...] } body, caps to maxTasks, and orders by updated_at ?? created_at', async () => {
    const { client, poster } = makeClient();
    // maxTasks=2 -> per_page=2. 'a' has only created_at (exercises the ?? fallback).
    const url = `${REST_BASE}/agents/tasks?per_page=2`;
    poster.on(url, json({
      tasks: [
        { id: 'a', created_at: '2026-07-02T00:00:00Z' },
        { id: 'b', updated_at: '2026-07-06T00:00:00Z', created_at: '2026-07-01T00:00:00Z' },
        { id: 'c', updated_at: '2026-07-04T00:00:00Z' },
      ],
    }));

    const res = await client.listMyTasks(AUTH, 2);

    expect(res.ok).toBe(true);
    if (res.ok) {
      // Newest-first (b=07-06, c=07-04, a=07-02) then capped to 2.
      expect(res.value.map((t) => t.id)).toEqual(['b', 'c']);
    }
  });
});

describe('CloudApiClient.getTaskDetail', () => {
  it('returns the parsed detail (with nested sessions) on a well-formed body', async () => {
    const { client, poster } = makeClient();
    const url = `${REST_BASE}/agents/tasks/task-1`;
    poster.on(url, json({
      id: 'task-1',
      name: 'Fix bug',
      state: 'completed',
      sessions: [{ id: 's1' }, { id: 's2' }],
    }));

    const res = await client.getTaskDetail(AUTH, 'task-1');

    expect(poster.gets[0].url).toBe(url);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.id).toBe('task-1');
      expect(res.value.sessions?.map((s) => s.id)).toEqual(['s1', 's2']);
    }
  });

  it('rejects a body without a string id as { ok:false, reason:"error" }', async () => {
    const { client, poster } = makeClient();
    const url = `${REST_BASE}/agents/tasks/task-x`;
    poster.on(url, json({ id: 123, name: 'no string id' }));

    const res = await client.getTaskDetail(AUTH, 'task-x');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('error');
    }
  });
});

describe('CloudApiClient.resolveRepo', () => {
  it('parses { id, name, owner:{login} } into a CloudRepoRef using the requested id', async () => {
    const { client, poster } = makeClient();
    const url = `${REST_BASE}/repositories/999`;
    // Body id deliberately differs from the requested id — the ref must use the
    // requested (immutable) id, not the payload's.
    poster.on(url, json({ id: 111, name: 'repo-name', owner: { login: 'octo' } }));

    const res = await client.resolveRepo(AUTH, 999);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ id: 999, owner: 'octo', name: 'repo-name' });
    }
  });

  it('rejects a payload missing owner.login or name as { ok:false, reason:"error" }', async () => {
    const { client, poster } = makeClient();
    poster.on(`${REST_BASE}/repositories/7`, json({ id: 7, owner: { login: 'octo' } }));

    const res = await client.resolveRepo(AUTH, 7);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('error');
    }
  });

  it('caches the resolved ref so a second call makes no HTTP GET', async () => {
    const { client, poster } = makeClient();
    const url = `${REST_BASE}/repositories/500`;
    poster.on(url, json({ id: 500, name: 'cached-repo', owner: { login: 'acme' } }));

    const first = await client.resolveRepo(AUTH, 500);
    const second = await client.resolveRepo(AUTH, 500);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(second.value).toEqual(first.value);
    }
    // Only the first call hit the network.
    expect(poster.getsMatching('/repositories/500')).toHaveLength(1);
  });

  it('seedRepoCache + knownRepos round-trip (seeded refs served from cache, no GET)', async () => {
    const { client, poster } = makeClient();
    const refs: CloudRepoRef[] = [
      { id: 1, owner: 'o1', name: 'n1' },
      { id: 2, owner: 'o2', name: 'n2' },
    ];
    client.seedRepoCache(refs);

    const res = await client.resolveRepo(AUTH, 1);

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toEqual({ id: 1, owner: 'o1', name: 'n1' });
    }
    // Served from the seeded cache — no network at all.
    expect(poster.gets).toHaveLength(0);
    expect(client.knownRepos()).toEqual(expect.arrayContaining(refs));
    expect(client.knownRepos()).toHaveLength(2);
  });
});

describe('CloudApiClient.fetchSessionLog', () => {
  it('GETs {capiBase}/agents/sessions/{id}/logs with CAPI headers and returns the raw body verbatim', async () => {
    const { client, poster } = makeClient();
    const url = `${CAPI_BASE}/agents/sessions/sess-1/logs`;
    // Raw SSE-ish body — must be returned byte-for-byte, NOT JSON-parsed.
    const raw = 'data: {"choices":[{"delta":{"content":"hi"}}]}\n\ndata: [DONE]\n\n';
    poster.on(url, { status: 200, body: raw });

    const res = await client.fetchSessionLog(AUTH, 'sess-1');

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value).toBe(raw);
    }
    expect(poster.gets[0].url).toBe(url);
    const headers = poster.gets[0].headers!;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers['Copilot-Integration-Id']).toBe('copilot-4-cli');
    expect(headers['X-GitHub-Api-Version']).toBe('2026-01-09');
  });

  it('maps a 404 to reason "featureUnavailable"', async () => {
    const { client, poster } = makeClient();
    poster.on(`${CAPI_BASE}/agents/sessions/gone/logs`, { status: 404, body: '' });

    const res = await client.fetchSessionLog(AUTH, 'gone');

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('featureUnavailable');
    }
  });
});

describe('CloudApiClient.getJson failure mapping (via listMyTasks)', () => {
  it('maps a 429 to reason "rateLimited"', async () => {
    const { client, poster } = makeClient();
    poster.on(`${REST_BASE}/agents/tasks?per_page=10`, { status: 429, body: '' });

    const res = await client.listMyTasks(AUTH, 10);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('rateLimited');
    }
  });

  it('maps an unparseable JSON body to reason "error"', async () => {
    const { client, poster } = makeClient();
    poster.on(`${REST_BASE}/agents/tasks?per_page=10`, { status: 200, body: 'not json {' });

    const res = await client.listMyTasks(AUTH, 10);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('error');
      expect(res.message).toContain('unparseable');
    }
  });

  it('maps a thrown transport error to reason "network"', async () => {
    const { client, poster } = makeClient();
    poster.getThrows = new Error('getaddrinfo ENOTFOUND api.github.com');

    const res = await client.listMyTasks(AUTH, 10);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('network');
    }
  });
});
