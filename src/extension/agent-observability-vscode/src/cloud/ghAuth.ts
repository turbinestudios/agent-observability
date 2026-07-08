/**
 * Per-account auth resolution for the Copilot (Cloud) source.
 *
 * For each configured gh account we need three things (all cached per account):
 *  - a **token** — either the account's gh OAuth token (`gh auth token --user
 *    <login>`, which returns that account's token regardless of `gh auth switch`)
 *    or a per-account PAT override stored in SecretStorage;
 *  - the **CAPI base** — resolved per account via the GitHub GraphQL
 *    `viewer.copilotEndpoints.api` (enterprise vs individual differ);
 *  - the account's numeric **user id** (`GET /user`) for ownership + labeling.
 *
 * Both the gh shell-out and the network calls sit behind injectable seams
 * ({@link GhExec} / {@link HttpPoster}) so this is unit-testable headless. Tokens
 * are NEVER logged (see the transport's discipline). Identities are pinned by
 * login — this module never reads the "active" gh account.
 */

import { execFile } from 'node:child_process';
import type { HttpPoster } from '../sync/httpPoster';
import type { FailureReason } from '../telemetry/telemetryService';
import { CloudAccountAuth } from './cloudTypes';

/** GitHub's public REST/GraphQL base. */
const GITHUB_API_BASE = 'https://api.github.com';
/** How long a resolved account auth stays cached before re-resolution. */
const DEFAULT_CACHE_TTL_MS = 10 * 60 * 1000;
/** `gh --version` / token probe timeout. */
const EXEC_TIMEOUT_MS = 8_000;

/**
 * A typed non-2xx outcome shared by the auth resolver and the API client. Never
 * throws into the poller. `retryAfterMs` is populated only for `rateLimited`
 * outcomes when the response carried a `Retry-After` / `x-ratelimit-reset` hint,
 * so the poller can back off exactly as long as GitHub asks (plan §4.1).
 */
export interface ApiFailure {
  ok: false;
  reason: FailureReason;
  message: string;
  retryAfterMs?: number;
}

/** Result of resolving an account's auth. Never throws into the poller. */
export type AuthResult = { ok: true; auth: CloudAccountAuth } | ApiFailure;

/** Injectable process runner for `gh` (tests inject a fake). */
export interface GhExec {
  /** Run `<gh> args`; resolve the outcome (never rejects). */
  run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; notFound: boolean }>;
}

export interface GhAuthDeps {
  /** Resolves the configured gh CLI path (blank → `gh`). */
  ghCliPath: () => string;
  /** Transport for GraphQL + `/user` (reused across accounts). */
  http: HttpPoster;
  /** Per-account PAT override lookup (SecretStorage), or `undefined` when none. */
  patFor: (login: string) => Promise<string | undefined>;
  /** Injectable gh runner (defaults to a real `execFile`-backed runner). */
  exec?: GhExec;
  platform?: NodeJS.Platform;
  now?: () => number;
  cacheTtlMs?: number;
}

/** The gh command candidates to try (Windows appends `.exe`/`.cmd` fallbacks). */
export function ghCommandCandidates(cliPath: string, platform: NodeJS.Platform): string[] {
  const base = cliPath.trim().length > 0 ? cliPath.trim() : 'gh';
  const hasDirOrExt = /[\\/]/.test(base) || /\.[a-z0-9]+$/i.test(base);
  if (platform === 'win32' && !hasDirOrExt) {
    return [base, `${base}.exe`, `${base}.cmd`];
  }
  return [base];
}

/** Real `execFile`-backed gh runner: tries each candidate until one is found. */
function realExec(ghCliPath: () => string, platform: NodeJS.Platform): GhExec {
  return {
    run(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string; notFound: boolean }> {
      const candidates = ghCommandCandidates(ghCliPath(), platform);
      const tryAt = (index: number): Promise<{ ok: boolean; stdout: string; stderr: string; notFound: boolean }> =>
        new Promise((resolve) => {
          const command = candidates[index];
          execFile(
            command,
            args,
            { timeout: EXEC_TIMEOUT_MS, windowsHide: true, maxBuffer: 1024 * 1024 },
            (err, stdout, stderr) => {
              // Treat any spawn failure (missing/inaccessible/invalid executable),
              // not just ENOENT, as "not found" so it maps to cliMissing (a helpful
              // "set ghCliPath" hint) rather than "not signed in".
              const code = err !== null ? (err as NodeJS.ErrnoException).code : undefined;
              const notFound = code === 'ENOENT' || code === 'EACCES' || code === 'EINVAL' || code === 'EPERM';
              if (notFound && index + 1 < candidates.length) {
                resolve(tryAt(index + 1));
                return;
              }
              resolve({
                ok: err === null,
                stdout: typeof stdout === 'string' ? stdout : String(stdout),
                stderr: typeof stderr === 'string' ? stderr : String(stderr),
                notFound,
              });
            },
          );
        });
      return tryAt(0);
    },
  };
}

interface CacheEntry {
  atMs: number;
  auth: CloudAccountAuth;
}

export class GhAuth {
  private readonly exec: GhExec;
  private readonly now: () => number;
  private readonly cacheTtlMs: number;
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly deps: GhAuthDeps) {
    const platform = deps.platform ?? process.platform;
    this.exec = deps.exec ?? realExec(deps.ghCliPath, platform);
    this.now = deps.now ?? (() => Date.now());
    this.cacheTtlMs = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /** Drop cached auth so the next resolve re-reads the token/endpoints. */
  invalidate(): void {
    this.cache.clear();
  }

  /**
   * The currently-active gh login (`gh api user --jq .login`), used ONCE to seed
   * `copilotCloud.accounts` when the user enables the source with it empty. After
   * that, identities are pinned — the active account is never read again.
   */
  async resolveActiveLogin(): Promise<string | undefined> {
    const res = await this.exec.run(['api', 'user', '--jq', '.login']);
    if (!res.ok) {
      return undefined;
    }
    const login = res.stdout.trim();
    return login.length > 0 ? login : undefined;
  }

  /** Resolve (and cache) an account's token + CAPI base + user id. */
  async resolveAccount(login: string): Promise<AuthResult> {
    const cached = this.cache.get(login);
    if (cached !== undefined && this.now() - cached.atMs < this.cacheTtlMs) {
      return { ok: true, auth: cached.auth };
    }

    const tokenResult = await this.resolveToken(login);
    if (!tokenResult.ok) {
      return tokenResult;
    }
    const { token, source } = tokenResult;

    const capiResult = await this.resolveCapiBase(token);
    if (!capiResult.ok) {
      return capiResult;
    }

    const userId = await this.resolveUserId(token);
    const auth: CloudAccountAuth = { login, token, capiBase: capiResult.capiBase, userId, source };
    this.cache.set(login, { atMs: this.now(), auth });
    return { ok: true, auth };
  }

  /** Prefer a per-account PAT override, else the account's gh OAuth token. */
  private async resolveToken(
    login: string,
  ): Promise<{ ok: true; token: string; source: 'gh' | 'pat' } | ApiFailure> {
    const pat = await this.deps.patFor(login);
    if (pat !== undefined && pat.trim().length > 0) {
      return { ok: true, token: pat.trim(), source: 'pat' };
    }
    const res = await this.exec.run(['auth', 'token', '--user', login]);
    if (res.notFound) {
      return {
        ok: false,
        reason: 'cliMissing',
        message: `${login}: GitHub CLI not found — set copilotCloud.ghCliPath or add a token via “Copilot (Cloud): Set account token”.`,
      };
    }
    const token = res.stdout.trim();
    if (!res.ok || token.length === 0) {
      return {
        ok: false,
        reason: 'unauthenticated',
        message: `${login}: not signed in — run \`gh auth login\` (or set a token via “Copilot (Cloud): Set account token”).`,
      };
    }
    return { ok: true, token, source: 'gh' };
  }

  /** Resolve the per-account CAPI base via GraphQL `viewer.copilotEndpoints.api`. */
  private async resolveCapiBase(
    token: string,
  ): Promise<{ ok: true; capiBase: string } | ApiFailure> {
    const body = JSON.stringify({ query: '{ viewer { copilotEndpoints { api } } }' });
    let status: number;
    let text: string;
    let header: ((name: string) => string | undefined) | undefined;
    try {
      const res = await this.deps.http.post(`${GITHUB_API_BASE}/graphql`, this.authHeaders(token), body);
      status = res.status;
      text = res.body;
      header = res.header;
    } catch (err) {
      return { ok: false, reason: 'network', message: networkMessage(err) };
    }
    const failure = statusFailure(status, header);
    if (failure !== undefined) {
      return failure;
    }
    try {
      const parsed = JSON.parse(text) as {
        data?: { viewer?: { copilotEndpoints?: { api?: unknown } } };
      };
      const api = parsed.data?.viewer?.copilotEndpoints?.api;
      if (typeof api === 'string' && api.length > 0) {
        return { ok: true, capiBase: api.replace(/\/+$/, '') };
      }
    } catch {
      // fall through to featureUnavailable
    }
    return {
      ok: false,
      reason: 'featureUnavailable',
      message: 'Could not resolve the Copilot CAPI endpoint for this account (Copilot may not be enabled).',
    };
  }

  /** Best-effort numeric user id (`GET /user`); undefined on any failure. */
  private async resolveUserId(token: string): Promise<number | undefined> {
    try {
      const res = await this.deps.http.get(`${GITHUB_API_BASE}/user`, this.authHeaders(token));
      if (res.status !== 200) {
        return undefined;
      }
      const parsed = JSON.parse(res.body) as { id?: unknown };
      return typeof parsed.id === 'number' ? parsed.id : undefined;
    } catch {
      return undefined;
    }
  }

  private authHeaders(token: string): Record<string, string> {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    };
  }
}

/**
 * Map a non-2xx status to a typed failure, or `undefined` for success. `header`
 * (when the transport supplies it) disambiguates a 403: GitHub returns 403 for
 * BOTH auth failures and primary/secondary rate limits, so a 403 that carries
 * rate-limit signals is mapped to `rateLimited` (→ backoff) rather than
 * `unauthenticated`.
 */
export function statusFailure(
  status: number,
  header?: (name: string) => string | undefined,
): ApiFailure | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 429 || (status === 403 && isRateLimit(header))) {
    return {
      ok: false,
      reason: 'rateLimited',
      message: 'GitHub API rate limited — backing off.',
      retryAfterMs: rateLimitRetryMs(header),
    };
  }
  if (status === 401 || status === 403) {
    return { ok: false, reason: 'unauthenticated', message: 'GitHub rejected the token (401/403) — it may be expired or lack scope.' };
  }
  if (status === 404) {
    return { ok: false, reason: 'featureUnavailable', message: 'Endpoint not found (404) — the preview API may be unavailable for this account/org.' };
  }
  return { ok: false, reason: 'error', message: `GitHub API returned HTTP ${status}.` };
}

/** GitHub rate-limit signal: a `Retry-After` header or `x-ratelimit-remaining: 0`. */
function isRateLimit(header?: (name: string) => string | undefined): boolean {
  if (header === undefined) {
    return false;
  }
  return header('retry-after') !== undefined || header('x-ratelimit-remaining') === '0';
}

/**
 * How long GitHub wants us to wait, in ms, from a rate-limited response: the
 * `Retry-After` seconds (secondary limits) or the delta to `x-ratelimit-reset`
 * epoch seconds (primary limit), whichever is present. `undefined` when neither
 * header is usable — the caller then applies its own default backoff.
 */
export function rateLimitRetryMs(
  header?: (name: string) => string | undefined,
  nowMs: number = Date.now(),
): number | undefined {
  if (header === undefined) {
    return undefined;
  }
  const retryAfter = header('retry-after');
  if (retryAfter !== undefined) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs) && secs >= 0) {
      return Math.round(secs * 1000);
    }
  }
  const reset = header('x-ratelimit-reset');
  if (reset !== undefined) {
    const epochSecs = Number(reset);
    if (Number.isFinite(epochSecs)) {
      const deltaMs = epochSecs * 1000 - nowMs;
      if (deltaMs > 0) {
        return deltaMs;
      }
    }
  }
  return undefined;
}

/** A network-error message that never leaks request contents. */
export function networkMessage(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code !== undefined ? `Network error (${code}) reaching GitHub.` : 'Network error reaching GitHub.';
}
