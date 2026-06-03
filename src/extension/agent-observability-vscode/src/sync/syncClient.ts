import { AggregateBatch } from '../aggregate/models';
import { HttpPoster, HttpResponse } from './httpPoster';

/**
 * Typed client over the dashboard ingestion API (Phase 7).
 *
 * Wraps an injectable {@link HttpPoster}, building the two ingestion requests and
 * mapping HTTP status codes to a discriminated {@link SyncOutcome} the engine can
 * branch on without ever inspecting raw HTTP. The endpoints and auth follow
 * `docs/architecture/api-auth.md`:
 *  - `POST {dashboardUrl}/api/ingest/aggregate` — body = the {@link AggregateBatch}
 *    JSON, `Authorization: Bearer <orgApiKey>`.
 *  - `POST {dashboardUrl}/api/ingest/status` — a tiny best-effort status report.
 *  - `GET  {dashboardUrl}/api/ingest/health` — anonymous.
 *
 * PRIVACY/SECURITY invariants (enforced and tested):
 *  - The API key is NEVER logged and NEVER placed in any returned outcome,
 *    message, or thrown error. It exists only inside the `Authorization` header
 *    handed to the poster.
 *  - The request body (the aggregate batch) is NEVER logged or echoed into any
 *    returned string. Server-supplied error detail is included verbatim only for
 *    the `rejected` (400) case so the user sees WHY the server refused the batch;
 *    that detail is the server's, never our key or body.
 */

/** A small, non-sensitive status report posted to `/api/ingest/status`. */
export interface SyncStatusReport {
  /** Extension semver. */
  toolVersion: string;
  /** Outcome discriminator of the most recent sync attempt. */
  lastOutcome: string;
  /** Epoch ms the report was produced (diagnostics). */
  reportedAtMs: number;
  /** Buckets sent in the most recent successful upload (optional). */
  bucketsSent?: number;
  /** Inclusive UTC window start of the last attempt (epoch ms, optional). */
  windowStartMs?: number;
  /** Exclusive UTC window end of the last attempt (epoch ms, optional). */
  windowEndMs?: number;
}

/**
 * The result of attempting to send a batch, mapped from the HTTP status:
 *  - `success`      — 200; server accepted the batch.
 *  - `unauthorized` — 401; bad/missing/revoked key (permanent — re-auth needed).
 *  - `rejected`     — 400; invalid batch / a raw field was rejected (permanent).
 *  - `disabled`     — 503; ingestion disabled server-side (permanent for now).
 *  - `serverError`  — other 5xx; transient, safe to retry.
 *  - `rateLimited`  — 429; transient, honor `Retry-After`.
 *  - `network`      — the request never completed (DNS/TLS/abort); transient.
 *  - `misconfigured`— no dashboard URL and/or no API key locally (permanent).
 */
export type SyncOutcome =
  | { kind: 'success'; accepted: boolean; batchId: string }
  | { kind: 'unauthorized' }
  | { kind: 'rejected'; detail: string }
  | { kind: 'disabled' }
  | { kind: 'serverError'; status: number }
  | { kind: 'rateLimited'; retryAfterMs?: number }
  | { kind: 'network'; message: string }
  | { kind: 'misconfigured' };

/** Whether an outcome is transient (safe + worth retrying). */
export function isTransient(outcome: SyncOutcome): boolean {
  return (
    outcome.kind === 'network' ||
    outcome.kind === 'serverError' ||
    outcome.kind === 'rateLimited'
  );
}

export class SyncClient {
  /**
   * @param poster injectable HTTP transport (real fetch in prod, fake in tests).
   * @param getDashboardUrl resolves the configured ingestion base URL (may be blank).
   * @param getApiKey resolves the stored org API key (may be undefined). The
   *   returned value is used ONLY to build the `Authorization` header and is
   *   never logged or returned.
   */
  constructor(
    private readonly poster: HttpPoster,
    private readonly getDashboardUrl: () => string,
    private readonly getApiKey: () => Promise<string | undefined>,
  ) {}

  /**
   * POST an aggregate batch to `/api/ingest/aggregate`. Returns a typed
   * {@link SyncOutcome}; never throws (a network failure becomes `network`).
   */
  async sendBatch(batch: AggregateBatch): Promise<SyncOutcome> {
    const config = await this.resolveConfig();
    if (config === undefined) {
      return { kind: 'misconfigured' };
    }
    const { baseUrl, apiKey } = config;

    const url = joinUrl(baseUrl, '/api/ingest/aggregate');
    // The body is the batch JSON; never logged or echoed anywhere.
    const body = JSON.stringify(batch);
    const headers = { Authorization: `Bearer ${apiKey}` };

    let res: HttpResponse;
    try {
      res = await this.poster.post(url, headers, body);
    } catch (err) {
      // Never let a raw transport error leak the URL/headers/body. Surface only a
      // short, key-free hint (and defensively scrub the key in case it appeared).
      return { kind: 'network', message: scrubKey(networkMessage(err), apiKey) };
    }

    // Defensively scrub the key from any human-readable detail before returning,
    // so even a server that echoes the Authorization header can never leak it.
    return scrubOutcome(this.mapStatus(res), apiKey);
  }

  /**
   * Best-effort POST of a small status report to `/api/ingest/status`. Never
   * throws and never blocks the sync result — failures are swallowed silently
   * (no logging of the key or body). Returns `true` on a 2xx, `false` otherwise.
   */
  async reportStatus(report: SyncStatusReport): Promise<boolean> {
    try {
      const config = await this.resolveConfig();
      if (config === undefined) {
        return false;
      }
      const { baseUrl, apiKey } = config;
      const url = joinUrl(baseUrl, '/api/ingest/status');
      const res = await this.poster.post(
        url,
        { Authorization: `Bearer ${apiKey}` },
        JSON.stringify(report),
      );
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /** Anonymous health probe. Returns `true` on a 2xx, `false` otherwise/throws. */
  async checkHealth(): Promise<boolean> {
    const baseUrl = this.getDashboardUrl().trim();
    if (baseUrl.length === 0) {
      return false;
    }
    try {
      const res = await this.poster.get(joinUrl(baseUrl, '/api/ingest/health'));
      return res.status >= 200 && res.status < 300;
    } catch {
      return false;
    }
  }

  /** Resolve and validate the base URL + key; `undefined` => misconfigured. */
  private async resolveConfig(): Promise<{ baseUrl: string; apiKey: string } | undefined> {
    const baseUrl = this.getDashboardUrl().trim();
    const apiKey = (await this.getApiKey())?.trim();
    if (baseUrl.length === 0 || apiKey === undefined || apiKey.length === 0) {
      return undefined;
    }
    return { baseUrl, apiKey };
  }

  /** Map a raw HTTP response to a typed {@link SyncOutcome}. */
  private mapStatus(res: HttpResponse): SyncOutcome {
    const { status } = res;
    if (status === 200) {
      const parsed = parseAccepted(res.body);
      return { kind: 'success', accepted: parsed.accepted, batchId: parsed.batchId };
    }
    if (status === 400) {
      return { kind: 'rejected', detail: extractDetail(res.body) };
    }
    if (status === 401 || status === 403) {
      // 403 (authenticated-but-not-permitted) is also surfaced as unauthorized so
      // the user is prompted to re-check their key/org; neither is retried.
      return { kind: 'unauthorized' };
    }
    if (status === 429) {
      return { kind: 'rateLimited', retryAfterMs: parseRetryAfterMs(res) };
    }
    if (status === 503) {
      return { kind: 'disabled' };
    }
    if (status >= 500) {
      return { kind: 'serverError', status };
    }
    // Any other unexpected status (e.g. 404/413) is treated as a permanent
    // rejection with a generic, key-free detail so the user sees a clear error.
    return { kind: 'rejected', detail: `Unexpected response status ${status}.` };
  }
}

/**
 * Replace any occurrence of the API key in a string with a fixed placeholder.
 * Defense-in-depth: the only string we ever return that contains server text is
 * the 400 `rejected.detail` (or a network message), and a misbehaving server
 * could in theory echo back the Authorization header. This guarantees the key
 * never appears in any outcome string regardless of server behavior.
 */
function scrubKey(text: string, apiKey: string): string {
  if (apiKey.length === 0 || !text.includes(apiKey)) {
    return text;
  }
  return text.split(apiKey).join('[redacted]');
}

/** Scrub the API key from any human-readable field carried by an outcome. */
function scrubOutcome(outcome: SyncOutcome, apiKey: string): SyncOutcome {
  if (outcome.kind === 'rejected') {
    return { kind: 'rejected', detail: scrubKey(outcome.detail, apiKey) };
  }
  if (outcome.kind === 'network') {
    return { kind: 'network', message: scrubKey(outcome.message, apiKey) };
  }
  return outcome;
}

/** Join a base URL and a path, collapsing a duplicated boundary slash. */
function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

/** Parse `{ accepted, batchId }` from a 200 body, defensively. */
function parseAccepted(body: string): { accepted: boolean; batchId: string } {
  try {
    const obj = JSON.parse(body) as { accepted?: unknown; batchId?: unknown };
    return {
      accepted: typeof obj.accepted === 'boolean' ? obj.accepted : true,
      batchId: typeof obj.batchId === 'string' ? obj.batchId : '',
    };
  } catch {
    return { accepted: true, batchId: '' };
  }
}

/**
 * Extract a short human-readable detail from a 400 body. Prefers a structured
 * `{ error }` / `{ message }` field; falls back to the trimmed raw body (capped)
 * so the user sees the server's reason. This is the server's text, never our key
 * or request body.
 */
function extractDetail(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    return 'The server rejected the batch as invalid.';
  }
  try {
    const obj = JSON.parse(trimmed) as { error?: unknown; message?: unknown; detail?: unknown };
    const field = obj.message ?? obj.error ?? obj.detail;
    if (typeof field === 'string' && field.length > 0) {
      return cap(field);
    }
  } catch {
    // Not JSON — fall through to the raw (capped) body.
  }
  return cap(trimmed);
}

/** Cap a string to a sane length for display in a notification. */
function cap(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Parse a `Retry-After` header (delta-seconds or an HTTP-date) to milliseconds,
 * or `undefined` when absent/unparseable. The engine clamps/defaults this.
 */
function parseRetryAfterMs(res: HttpResponse): number | undefined {
  const raw = res.header?.('retry-after');
  if (raw === undefined) {
    return undefined;
  }
  const value = raw.trim();
  if (value.length === 0) {
    return undefined;
  }
  // delta-seconds form.
  if (/^\d+$/.test(value)) {
    return Number(value) * 1000;
  }
  // HTTP-date form.
  const dateMs = Date.parse(value);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Build a short, key-free network error hint. Deliberately conservative: it never
 * includes the request URL, headers, or body — only the error's own message
 * (which is about the transport, not our payload).
 */
function networkMessage(err: unknown): string {
  if (err instanceof Error && err.message.length > 0) {
    return cap(err.message, 200);
  }
  return 'Network request failed.';
}
