import { describe, it, expect } from 'vitest';
import { GhAuth, GhExec, AuthResult, ghCommandCandidates, statusFailure } from './ghAuth';
import { HttpPoster, HttpResponse } from '../sync/httpPoster';

/**
 * GhAuth unit tests with fully injected seams: a fake {@link GhExec} that records
 * every `gh` invocation, a fake {@link HttpPoster} that routes GraphQL/`/user`
 * calls to canned responses, a `patFor` lookup, and a mutable clock. These pin the
 * happy-path resolution, the PAT override, the typed failure mapping, and the
 * per-account cache TTL / invalidation — all without touching a real `gh` or the
 * network. Pure helpers ({@link ghCommandCandidates}, {@link statusFailure}) are
 * exercised directly.
 */

// ---------------------------------------------------------------------------
// Fakes + builders
// ---------------------------------------------------------------------------

type ExecResponse = { ok: boolean; stdout: string; stderr: string; notFound: boolean };

function execOk(stdout: string): ExecResponse {
  return { ok: true, stdout, stderr: '', notFound: false };
}
function execFail(stderr = ''): ExecResponse {
  return { ok: false, stdout: '', stderr, notFound: false };
}
function execNotFound(): ExecResponse {
  return { ok: false, stdout: '', stderr: '', notFound: true };
}

/** Records every `gh` call; resolves each via the injected handler. */
class FakeGhExec implements GhExec {
  readonly calls: string[][] = [];
  constructor(private readonly handler: (args: string[]) => ExecResponse) {}
  async run(args: string[]): Promise<ExecResponse> {
    this.calls.push(args);
    return this.handler(args);
  }
  /** Count of `gh auth token …` (the token probe) invocations. */
  get tokenProbeCount(): number {
    return this.calls.filter((a) => a[0] === 'auth' && a[1] === 'token').length;
  }
}

/** A handler that answers the token probe and `api user` distinctly. */
function ghHandler(opts: { token?: ExecResponse; login?: ExecResponse }): (args: string[]) => ExecResponse {
  return (args) => {
    if (args[0] === 'auth' && args[1] === 'token') {
      return opts.token ?? execFail();
    }
    if (args[0] === 'api' && args[1] === 'user') {
      return opts.login ?? execFail();
    }
    return execFail('unexpected gh args');
  };
}

/** Fake poster: routes POST->GraphQL and GET->`/user`, recording every call. */
class FakeHttpPoster implements HttpPoster {
  readonly posts: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  readonly gets: Array<{ url: string; headers?: Record<string, string> }> = [];
  constructor(
    private readonly opts: {
      graphql?: HttpResponse;
      user?: HttpResponse;
      postThrows?: Error;
    },
  ) {}
  async post(url: string, headers: Record<string, string>, body: string): Promise<HttpResponse> {
    this.posts.push({ url, headers, body });
    if (this.opts.postThrows) {
      throw this.opts.postThrows;
    }
    return this.opts.graphql ?? { status: 500, body: '' };
  }
  async get(url: string, headers?: Record<string, string>): Promise<HttpResponse> {
    this.gets.push({ url, headers });
    return this.opts.user ?? { status: 500, body: '' };
  }
}

function graphqlOk(api: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify({ data: { viewer: { copilotEndpoints: { api } } } }) };
}
function userOk(id: unknown): HttpResponse {
  return { status: 200, body: JSON.stringify({ id }) };
}

interface MakeOpts {
  exec?: GhExec;
  http?: HttpPoster;
  patFor?: (login: string) => Promise<string | undefined>;
  platform?: NodeJS.Platform;
  now?: () => number;
  cacheTtlMs?: number;
  ghCliPath?: string;
}

function makeAuth(opts: MakeOpts = {}): GhAuth {
  return new GhAuth({
    ghCliPath: () => opts.ghCliPath ?? 'gh',
    http: opts.http ?? new FakeHttpPoster({}),
    patFor: opts.patFor ?? (async () => undefined),
    // Always inject a fake exec so no test ever shells out to a real `gh`.
    exec: opts.exec ?? new FakeGhExec(() => execFail('no handler')),
    platform: opts.platform,
    now: opts.now,
    cacheTtlMs: opts.cacheTtlMs,
  });
}

/** Narrow an AuthResult to its failure arm for assertions. */
function asFailure(res: AuthResult): { reason: string; message: string } {
  expect(res.ok).toBe(false);
  if (res.ok) {
    throw new Error('expected failure');
  }
  return { reason: res.reason, message: res.message };
}

const CAPI = 'https://api.enterprise.githubcopilot.com';

// ---------------------------------------------------------------------------
// resolveAccount — happy path
// ---------------------------------------------------------------------------

describe('GhAuth.resolveAccount happy path (gh token)', () => {
  it('resolves token, CAPI base, and user id and pins source to gh', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_abc123\n') }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(`${CAPI}/`), user: userOk(123) });
    const auth = makeAuth({ exec, http });

    const res = await auth.resolveAccount('octocat');

    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error('expected success');
    }
    expect(res.auth.login).toBe('octocat');
    expect(res.auth.token).toBe('gho_abc123'); // trimmed
    expect(res.auth.capiBase).toBe(CAPI); // trailing slash stripped
    expect(res.auth.userId).toBe(123);
    expect(res.auth.source).toBe('gh');

    // The token probe was pinned by login, not the active account.
    expect(exec.calls).toContainEqual(['auth', 'token', '--user', 'octocat']);
    // GraphQL + /user targeted the public GitHub API with a Bearer header.
    expect(http.posts).toHaveLength(1);
    expect(http.posts[0].url).toBe('https://api.github.com/graphql');
    expect(http.posts[0].headers.Authorization).toBe('Bearer gho_abc123');
    expect(http.gets).toHaveLength(1);
    expect(http.gets[0].url).toBe('https://api.github.com/user');
    expect(http.gets[0].headers?.Authorization).toBe('Bearer gho_abc123');
  });

  it('strips multiple trailing slashes from the CAPI base', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_x') }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(`${CAPI}///`), user: userOk(1) });
    const res = await makeAuth({ exec, http }).resolveAccount('me');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.auth.capiBase).toBe(CAPI);
    }
  });

  it('succeeds with userId undefined when /user is best-effort unavailable', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_x') }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(CAPI), user: { status: 500, body: 'boom' } });
    const res = await makeAuth({ exec, http }).resolveAccount('me');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.auth.userId).toBeUndefined();
      expect(res.auth.capiBase).toBe(CAPI);
    }
  });
});

// ---------------------------------------------------------------------------
// resolveAccount — PAT override
// ---------------------------------------------------------------------------

describe('GhAuth.resolveAccount PAT override', () => {
  it('uses the PAT (trimmed), pins source to pat, and never probes gh for the token', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_should_not_be_used') }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(CAPI), user: userOk(7) });
    const auth = makeAuth({ exec, http, patFor: async () => '  pat_tok  ' });

    const res = await auth.resolveAccount('octocat');

    expect(res.ok).toBe(true);
    if (!res.ok) {
      throw new Error('expected success');
    }
    expect(res.auth.source).toBe('pat');
    expect(res.auth.token).toBe('pat_tok');
    // gh was never consulted for a token.
    expect(exec.tokenProbeCount).toBe(0);
    // The PAT (not a gh token) authorized the GraphQL call.
    expect(http.posts[0].headers.Authorization).toBe('Bearer pat_tok');
  });

  it('falls back to the gh token when patFor returns a blank string', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_real') }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(CAPI), user: userOk(1) });
    const res = await makeAuth({ exec, http, patFor: async () => '   ' }).resolveAccount('me');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.auth.source).toBe('gh');
      expect(res.auth.token).toBe('gho_real');
    }
    expect(exec.tokenProbeCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// resolveAccount — token failures
// ---------------------------------------------------------------------------

describe('GhAuth.resolveAccount token failures', () => {
  it('cliMissing when gh is not found and no PAT exists', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execNotFound() }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(CAPI), user: userOk(1) });
    const res = await makeAuth({ exec, http }).resolveAccount('octocat');
    const fail = asFailure(res);
    expect(fail.reason).toBe('cliMissing');
    // We never attempted the network once the token could not be resolved.
    expect(http.posts).toHaveLength(0);
  });

  it('unauthenticated when gh runs but returns an empty token', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execOk('   \n') }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(CAPI), user: userOk(1) });
    const res = await makeAuth({ exec, http }).resolveAccount('octocat');
    expect(asFailure(res).reason).toBe('unauthenticated');
    expect(http.posts).toHaveLength(0);
  });

  it('unauthenticated when gh exits non-zero (not signed in)', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execFail('not logged in') }));
    const res = await makeAuth({ exec }).resolveAccount('octocat');
    expect(asFailure(res).reason).toBe('unauthenticated');
  });
});

// ---------------------------------------------------------------------------
// resolveAccount — CAPI base failures
// ---------------------------------------------------------------------------

describe('GhAuth.resolveAccount CAPI base failures', () => {
  async function resolveWithGraphql(graphql: HttpResponse): Promise<AuthResult> {
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_x') }));
    const http = new FakeHttpPoster({ graphql, user: userOk(1) });
    return makeAuth({ exec, http }).resolveAccount('me');
  }

  it('maps a 401 GraphQL response to unauthenticated', async () => {
    expect(asFailure(await resolveWithGraphql({ status: 401, body: '' })).reason).toBe('unauthenticated');
  });

  it('maps a 404 GraphQL response to featureUnavailable', async () => {
    expect(asFailure(await resolveWithGraphql({ status: 404, body: '' })).reason).toBe('featureUnavailable');
  });

  it('maps malformed (missing api) GraphQL data to featureUnavailable', async () => {
    expect(asFailure(await resolveWithGraphql({ status: 200, body: '{"data":{"viewer":{}}}' })).reason).toBe(
      'featureUnavailable',
    );
  });

  it('maps unparseable GraphQL body to featureUnavailable', async () => {
    expect(asFailure(await resolveWithGraphql({ status: 200, body: 'not-json{' })).reason).toBe('featureUnavailable');
  });

  it('maps an empty-string api to featureUnavailable', async () => {
    expect(asFailure(await resolveWithGraphql(graphqlOk(''))).reason).toBe('featureUnavailable');
  });

  it('maps a transport throw to a network failure', async () => {
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_x') }));
    const http = new FakeHttpPoster({ postThrows: new Error('getaddrinfo ENOTFOUND') });
    const res = await makeAuth({ exec, http }).resolveAccount('me');
    expect(asFailure(res).reason).toBe('network');
  });
});

// ---------------------------------------------------------------------------
// caching
// ---------------------------------------------------------------------------

describe('GhAuth.resolveAccount caching', () => {
  it('serves a second call within the TTL from cache; invalidate() forces re-resolution', async () => {
    const t = { ms: 1000 };
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_x') }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(CAPI), user: userOk(1) });
    const auth = makeAuth({ exec, http, now: () => t.ms, cacheTtlMs: 5000 });

    const first = await auth.resolveAccount('me');
    expect(first.ok).toBe(true);
    expect(exec.tokenProbeCount).toBe(1);
    expect(http.posts).toHaveLength(1);
    expect(http.gets).toHaveLength(1);

    // Still within TTL — a full cache hit, no new work.
    t.ms = 1000 + 4999;
    const second = await auth.resolveAccount('me');
    expect(second.ok).toBe(true);
    expect(exec.tokenProbeCount).toBe(1);
    expect(http.posts).toHaveLength(1);
    expect(http.gets).toHaveLength(1);

    // invalidate() drops the cache; the next call re-resolves everything.
    auth.invalidate();
    const third = await auth.resolveAccount('me');
    expect(third.ok).toBe(true);
    expect(exec.tokenProbeCount).toBe(2);
    expect(http.posts).toHaveLength(2);
    expect(http.gets).toHaveLength(2);
  });

  it('re-resolves once the cached entry ages past the TTL', async () => {
    const t = { ms: 1000 };
    const exec = new FakeGhExec(ghHandler({ token: execOk('gho_x') }));
    const http = new FakeHttpPoster({ graphql: graphqlOk(CAPI), user: userOk(1) });
    const auth = makeAuth({ exec, http, now: () => t.ms, cacheTtlMs: 5000 });

    await auth.resolveAccount('me');
    expect(exec.tokenProbeCount).toBe(1);

    // Age exactly to the TTL boundary → no longer a hit (`< ttl` is false).
    t.ms = 1000 + 5000;
    await auth.resolveAccount('me');
    expect(exec.tokenProbeCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// resolveActiveLogin
// ---------------------------------------------------------------------------

describe('GhAuth.resolveActiveLogin', () => {
  it('returns the trimmed login from `gh api user --jq .login`', async () => {
    const exec = new FakeGhExec(ghHandler({ login: execOk('octocat\n') }));
    const login = await makeAuth({ exec }).resolveActiveLogin();
    expect(login).toBe('octocat');
    expect(exec.calls).toContainEqual(['api', 'user', '--jq', '.login']);
  });

  it('returns undefined when gh fails', async () => {
    const exec = new FakeGhExec(ghHandler({ login: execFail('no auth') }));
    expect(await makeAuth({ exec }).resolveActiveLogin()).toBeUndefined();
  });

  it('returns undefined when gh prints an empty login', async () => {
    const exec = new FakeGhExec(ghHandler({ login: execOk('  \n') }));
    expect(await makeAuth({ exec }).resolveActiveLogin()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// ghCommandCandidates (pure)
// ---------------------------------------------------------------------------

describe('ghCommandCandidates', () => {
  it('on win32 with a bare name appends .exe/.cmd fallbacks', () => {
    expect(ghCommandCandidates('gh', 'win32')).toEqual(['gh', 'gh.exe', 'gh.cmd']);
  });

  it('on win32 with a blank path defaults to gh and appends fallbacks', () => {
    expect(ghCommandCandidates('   ', 'win32')).toEqual(['gh', 'gh.exe', 'gh.cmd']);
  });

  it('on a non-win32 platform returns only the base', () => {
    expect(ghCommandCandidates('gh', 'linux')).toEqual(['gh']);
    expect(ghCommandCandidates('   ', 'darwin')).toEqual(['gh']);
  });

  it('on win32 returns only the base when the path has a separator', () => {
    expect(ghCommandCandidates('/usr/local/bin/gh', 'win32')).toEqual(['/usr/local/bin/gh']);
    expect(ghCommandCandidates('C:\\tools\\gh', 'win32')).toEqual(['C:\\tools\\gh']);
  });

  it('on win32 returns only the base when the path already has an extension', () => {
    expect(ghCommandCandidates('gh.exe', 'win32')).toEqual(['gh.exe']);
    expect(ghCommandCandidates('C:\\tools\\gh.cmd', 'win32')).toEqual(['C:\\tools\\gh.cmd']);
  });
});

// ---------------------------------------------------------------------------
// statusFailure (pure)
// ---------------------------------------------------------------------------

describe('statusFailure mapping', () => {
  it('returns undefined for any 2xx status', () => {
    expect(statusFailure(200)).toBeUndefined();
    expect(statusFailure(204)).toBeUndefined();
    expect(statusFailure(299)).toBeUndefined();
  });

  it('maps 401/403 to unauthenticated', () => {
    expect(statusFailure(401)?.reason).toBe('unauthenticated');
    expect(statusFailure(403)?.reason).toBe('unauthenticated');
  });

  it('maps 404 to featureUnavailable', () => {
    expect(statusFailure(404)?.reason).toBe('featureUnavailable');
  });

  it('maps 429 to rateLimited', () => {
    expect(statusFailure(429)?.reason).toBe('rateLimited');
  });

  it('maps other non-2xx statuses to a generic error', () => {
    expect(statusFailure(500)?.reason).toBe('error');
    expect(statusFailure(418)?.reason).toBe('error');
  });
});
