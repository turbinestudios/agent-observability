/**
 * The renderer ↔ data-host contract.
 *
 * Both sides import these types, so a method rename breaks the build rather
 * than failing silently at runtime. Messages travel over a MessagePort that the
 * main process hands to the renderer, so requests never round-trip through the
 * main thread.
 *
 * The core session API is synchronous; this is the single boundary where it is
 * wrapped into promises. Everything behind `RpcMethods` runs off the UI thread.
 */

/** A session row as stored in the index — a `SessionSummary` with display extras. */
export interface SessionRow {
  source: string;
  sessionId: string;
  repository: string;
  title?: string;
  titleDerived?: boolean;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  interactionCount: number;
  llmCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  model: string;
  agentModes: string[];
  stateLabel?: string;
  externalUrl?: string;
  /** Precomputed so list rows never recompute pricing. */
  costMicros?: number;
  /** Epoch ms this row was last written by the indexer. */
  indexedAtMs: number;
  /**
   * True while the row came from directory discovery alone and its counts have
   * not been parsed yet. Lets the list paint immediately on a cold start.
   */
  pending?: boolean;
}

/** One source → repository grouping with its session count, for list headers. */
export interface SessionGroup {
  source: string;
  repository: string;
  count: number;
  /** Newest `endedAtMs` in the group, so groups sort by recency. */
  newestMs: number;
}

export interface ListSessionsParams {
  source?: string;
  repository?: string;
  /** Free-text match over title and repository. */
  query?: string;
  offset?: number;
  limit?: number;
}

export interface IndexStatus {
  /** Sessions with parsed counts. */
  indexed: number;
  /** Sessions known to exist, including not-yet-parsed ones. */
  total: number;
  phase: 'idle' | 'discovering' | 'hydrating' | 'error';
  /** Present when `phase` is `error`. */
  message?: string;
}

/** Request/response methods. Every one resolves off the UI thread. */
export interface RpcMethods {
  ping(payload: string): string;
  'sessions.list'(params: ListSessionsParams): SessionRow[];
  'sessions.groups'(): SessionGroup[];
  'sessions.count'(params: ListSessionsParams): number;
  'index.status'(): IndexStatus;
  'index.refresh'(): IndexStatus;
  /** Drop and rebuild the index from scratch — the recovery path. */
  'index.rebuild'(): IndexStatus;
}

export type RpcMethodName = keyof RpcMethods;

export type RpcRequest = {
  [K in RpcMethodName]: {
    id: number;
    method: K;
    params: Parameters<RpcMethods[K]>;
  };
}[RpcMethodName];

export type RpcResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string };

/** Unsolicited pushes from the data host. */
export type RpcEvent =
  | { event: 'sessions.upserted'; rows: SessionRow[] }
  | { event: 'sessions.removed'; keys: string[] }
  | { event: 'index.progress'; status: IndexStatus };

export type RpcEventName = RpcEvent['event'];

/** Stable identity for a session row across sources. */
export function sessionKey(source: string, sessionId: string): string {
  return `${source}:${sessionId}`;
}
