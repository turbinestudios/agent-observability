/**
 * Pluggable reader over the cloud landing spot for autonomous-agent OTLP batches.
 *
 * All networking goes through the shared {@link ../sync/httpPoster.HttpPoster}
 * seam (the same transport the sync client + Copilot (Cloud) source use — never a
 * second HTTP stack), with a bearer token minted from SecretStorage. This layer
 * only lists + downloads raw batches and maps HTTP status to a typed
 * {@link ../telemetry/telemetryService.Result}; it NEVER decodes OTLP (the puller
 * hands the raw body to the shared `decodeTraceRequest`) and never throws into
 * the poller.
 *
 * Privacy note: the batches carry FULL agent telemetry (prompts, tool I/O). That
 * is by design for this source — the content ORIGINATES in the cloud relay, is
 * pulled to the LOCAL sink only, and is never re-uploaded (the source's
 * `getAggregationRows` returns `[]`). This client transports bytes and logs
 * nothing — not the URL, headers (bearer token), or body.
 */

import type { HttpPoster } from '../sync/httpPoster';
import type { FailureReason, Result } from '../telemetry/telemetryService';
import { AgentBatchReader, RawOtlpBatchRef } from './agentTypes';

export interface AgentBlobClientDeps {
  http: HttpPoster;
  /** Base URL of the landing spot (trailing slashes are trimmed). */
  endpoint: string;
  /** Bearer token for the relay, read from SecretStorage. `undefined` when unset. */
  getToken: () => Promise<string | undefined>;
}

/** Path under the endpoint that lists + serves raw OTLP batches. */
const BATCHES_PATH = 'agent-otlp/batches';

export class AgentBlobClient implements AgentBatchReader {
  private readonly base: string;

  constructor(private readonly deps: AgentBlobClientDeps) {
    this.base = deps.endpoint.replace(/\/+$/, '');
  }

  async listBatches(sinceMs: number, max: number): Promise<Result<RawOtlpBatchRef[]>> {
    const headers = await this.authHeaders();
    if (headers === undefined) {
      return tokenMissing();
    }
    const url = `${this.base}/${BATCHES_PATH}?since=${encodeURIComponent(String(Math.max(0, Math.floor(sinceMs))))}&limit=${encodeURIComponent(String(Math.max(1, Math.floor(max))))}`;
    let status: number;
    let body: string;
    try {
      const res = await this.deps.http.get(url, headers);
      status = res.status;
      body = res.body;
    } catch (err) {
      return networkFailure(err);
    }
    const failure = relayFailure(status);
    if (failure !== undefined) {
      return failure;
    }
    return { ok: true, value: parseBatchRefs(body, max) };
  }

  async downloadBatch(ref: RawOtlpBatchRef): Promise<Result<string>> {
    const headers = await this.authHeaders();
    if (headers === undefined) {
      return tokenMissing();
    }
    const url = `${this.base}/${BATCHES_PATH}/${encodeURIComponent(ref.id)}`;
    let status: number;
    let body: string;
    try {
      const res = await this.deps.http.get(url, headers);
      status = res.status;
      body = res.body;
    } catch (err) {
      return networkFailure(err);
    }
    const failure = relayFailure(status);
    if (failure !== undefined) {
      return failure;
    }
    return { ok: true, value: body };
  }

  /** Bearer headers, or `undefined` when no token is stored (do not even request). */
  private async authHeaders(): Promise<Record<string, string> | undefined> {
    const token = (await this.deps.getToken())?.trim();
    if (token === undefined || token.length === 0) {
      return undefined;
    }
    return { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  }
}

/**
 * Parse a batch listing into validated refs. Accepts a bare array or a
 * `{ batches: [...] }` envelope; tolerates and skips malformed entries (the relay
 * is our own but never trusted to be well-formed). Sorted newest-first and capped.
 */
function parseBatchRefs(body: string, max: number): RawOtlpBatchRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed)
    ? parsed
    : parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { batches?: unknown }).batches)
      ? (parsed as { batches: unknown[] }).batches
      : [];
  const refs: RawOtlpBatchRef[] = [];
  for (const item of arr) {
    if (item === null || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id : undefined;
    if (id === undefined || id.length === 0) {
      continue;
    }
    const createdAtMs = typeof rec.createdAtMs === 'number' && Number.isFinite(rec.createdAtMs) ? rec.createdAtMs : 0;
    const service = typeof rec.service === 'string' && rec.service.length > 0 ? rec.service : 'unknown';
    const sizeBytes = typeof rec.sizeBytes === 'number' && Number.isFinite(rec.sizeBytes) ? rec.sizeBytes : undefined;
    refs.push({ id, service, createdAtMs, sizeBytes });
  }
  refs.sort((a, b) => b.createdAtMs - a.createdAtMs);
  return refs.slice(0, Math.max(1, Math.floor(max)));
}

/** Map a non-2xx relay status to a typed failure, or `undefined` for success. */
function relayFailure(status: number): { ok: false; reason: FailureReason; message: string } | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  if (status === 429) {
    return { ok: false, reason: 'rateLimited', message: 'Agent relay rate limited — backing off.' };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      reason: 'unauthenticated',
      message: 'The agent relay rejected the token (401/403) — set or refresh it via “Agent Observability: Set Agent Relay Token”.',
    };
  }
  if (status === 404) {
    return { ok: false, reason: 'featureUnavailable', message: 'Agent relay endpoint not found (404) — check the configured endpoint.' };
  }
  return { ok: false, reason: 'error', message: `Agent relay returned HTTP ${status}.` };
}

function tokenMissing(): { ok: false; reason: FailureReason; message: string } {
  return {
    ok: false,
    reason: 'unauthenticated',
    message: 'No agent relay token set — add one via “Agent Observability: Set Agent Relay Token”.',
  };
}

/** A network-error failure that never leaks request contents. */
function networkFailure(err: unknown): { ok: false; reason: FailureReason; message: string } {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return {
    ok: false,
    reason: 'network',
    message: code !== undefined ? `Network error (${code}) reaching the agent relay.` : 'Network error reaching the agent relay.',
  };
}
