/**
 * Tiny HTTP seam for the sync engine.
 *
 * Phase 7 connects the local aggregate engine to the cloud ingestion API. To keep
 * the engine fully unit-testable headless (no real network, no `vscode`), all
 * networking is funneled through this {@link HttpPoster} interface so tests inject
 * a fake. The default {@link FetchHttpPoster} uses `globalThis.fetch`, which is
 * available in the VS Code extension host (Node 18+).
 *
 * Privacy: this layer is deliberately dumb. It never logs anything — not the URL,
 * not the headers (which carry the bearer key), not the body (which is the
 * aggregate batch JSON). Callers are responsible for what they pass in; this
 * module only transports bytes.
 */

/** A normalized HTTP response: the status code plus the raw (string) body. */
export interface HttpResponse {
  /** HTTP status code (e.g. 200, 401, 503). */
  status: number;
  /** Response body as text (may be empty). */
  body: string;
  /**
   * Lower-cased response header lookup. Optional so a fake can omit it; the
   * default impl provides it so the engine can read `Retry-After` on 429.
   */
  header?: (name: string) => string | undefined;
}

/**
 * The minimal networking surface the sync client needs. Injectable so the engine
 * is testable with a fake that records calls and returns canned responses.
 */
export interface HttpPoster {
  /** POST `body` (already-serialized string) with `headers` to `url`. */
  post(url: string, headers: Record<string, string>, body: string): Promise<HttpResponse>;
  /** Anonymous GET to `url` (used for the health endpoint). */
  get(url: string): Promise<HttpResponse>;
}

/**
 * Default {@link HttpPoster} backed by `globalThis.fetch`.
 *
 * Never logs the URL, headers, or body. A network/abort failure is surfaced by
 * throwing — the caller ({@link SyncClient}) catches it and maps it to a typed
 * `network` outcome (it never lets the raw error leak the request contents).
 */
export class FetchHttpPoster implements HttpPoster {
  async post(url: string, headers: Record<string, string>, body: string): Promise<HttpResponse> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    return this.toResponse(res);
  }

  async get(url: string): Promise<HttpResponse> {
    const res = await fetch(url, { method: 'GET' });
    return this.toResponse(res);
  }

  private async toResponse(res: Response): Promise<HttpResponse> {
    // Read the body defensively: a missing/closed body must not crash the engine.
    let text = '';
    try {
      text = await res.text();
    } catch {
      text = '';
    }
    return {
      status: res.status,
      body: text,
      header: (name: string) => res.headers.get(name) ?? undefined,
    };
  }
}
