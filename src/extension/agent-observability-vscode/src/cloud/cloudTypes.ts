/**
 * Shared type contracts + pure helpers for the **Copilot (Cloud)** source.
 *
 * This module pins every inter-module signature so `ghAuth` / `cloudApiClient` /
 * `sseParser` / `cloudMapper` / `cloudSink` / `cloudAgentPoller` /
 * `copilotCloudSource` all agree on the raw payload shapes, the parsed-log shape,
 * the sink index shape, and the mapper's input. It imports NO `vscode` and no
 * heavy dependency, so every consumer stays unit-testable headless.
 *
 * The GitHub agent-tasks REST API and the CAPI logs endpoint are **preview**
 * surfaces that drift (documented fields have gone missing; one 92-second log
 * already carried three payload shapes), so the raw types below are deliberately
 * permissive — known fields are all optional and callers tolerate extras. Raw
 * payloads are archived verbatim in the sink so a parser upgrade can re-derive
 * everything (see {@link SinkIndex.parserVersion}).
 */

/** The 8-value task lifecycle enum (REST `state`). Treated as an open string. */
export type CloudTaskState =
  | 'queued'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'idle'
  | 'waiting_for_user'
  | 'timed_out'
  | 'cancelled';

/** Terminal states: their logs are fetched once and never re-fetched. */
export const TERMINAL_CLOUD_STATES: ReadonlySet<string> = new Set<CloudTaskState>([
  'completed',
  'failed',
  'cancelled',
  'timed_out',
]);

/** Whether a task/session state is terminal (no more polling needed). */
export function isTerminalCloudState(state: string | undefined): boolean {
  return state !== undefined && TERMINAL_CLOUD_STATES.has(state);
}

/**
 * Human badge for a session's lifecycle state, or `undefined` when no badge is
 * warranted (a plain `completed` session needs none). Rendered on the Sessions
 * row and used to pick a state icon.
 */
export function cloudStateLabel(state: string | undefined): string | undefined {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'in_progress':
      return 'in progress';
    case 'idle':
      return 'idle';
    case 'waiting_for_user':
      return 'waiting for user';
    case 'failed':
      return 'failed';
    case 'timed_out':
      return 'timed out';
    case 'cancelled':
      return 'cancelled';
    case 'completed':
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Raw REST payloads (agent-tasks API). All fields optional — preview drift.
// ---------------------------------------------------------------------------

/** REST `usage` object nested on a session (`{ credits, type }`). */
export interface RawCloudUsage {
  /** AI-credit usage; scale UNCONFIRMED — stored raw, divided by 1e9 for display. */
  credits?: number;
  /** e.g. `ai_credits`. */
  type?: string;
}

/** One session nested inside a task detail (`GET agents/tasks/{id}`). */
export interface RawCloudSession {
  id: string;
  /** Per-session name (may differ from the task name for steer follow-ups). */
  name?: string;
  prompt?: string;
  /** Prefixed model, e.g. `sweagent-capi:claude-sonnet-4.6` — strip the prefix. */
  model?: string;
  state?: CloudTaskState | string;
  head_ref?: string;
  base_ref?: string;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  error?: string | null;
  usage?: RawCloudUsage;
  /** CAPI linkage seen on session objects (Phase 2+): the PR / workflow run. */
  resource_type?: string;
  resource_id?: string | number;
  workflow_run_id?: string | number;
  /** Preserve any undocumented fields so a re-parse can pick them up. */
  [key: string]: unknown;
}

/** One task from the list endpoints (`GET agents/tasks` / repo tasks). */
export interface RawCloudTask {
  id: string;
  name?: string;
  state?: CloudTaskState | string;
  session_count?: number;
  created_at?: string;
  updated_at?: string;
  completed_at?: string;
  /** Bare numeric ids — resolve to owner/repo via `GET repositories/{id}`. */
  repository?: number | string;
  owner?: number | string;
  creator?: { id?: number | string; login?: string };
  artifacts?: Array<{ provider?: string; type?: string }>;
  [key: string]: unknown;
}

/** A task detail (`GET agents/tasks/{id}`): the task fields plus nested sessions. */
export interface RawCloudTaskDetail extends RawCloudTask {
  sessions?: RawCloudSession[];
}

/** A resolved repository (`GET repositories/{id}`), cached by immutable id. */
export interface CloudRepoRef {
  id: number;
  owner: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Where an account's token came from. */
export type CloudAuthSource = 'gh' | 'pat';

/** A resolved, cached per-account auth context. */
export interface CloudAccountAuth {
  /** gh username / account label the token belongs to. */
  login: string;
  /** OAuth (`gho_…`) or PAT bearer token. Never logged. */
  token: string;
  /** CAPI base resolved via GraphQL `viewer.copilotEndpoints.api`, per account. */
  capiBase: string;
  /** The account's numeric user id (`GET /user`) for ownership + labeling. */
  userId?: number;
  source: CloudAuthSource;
}

// ---------------------------------------------------------------------------
// Parsed CAPI log (sseParser output → cloudMapper input)
// ---------------------------------------------------------------------------

/** A distinct tool invocation, from a call/result chunk pair sharing a chunk id. */
export interface CloudToolInvocation {
  /** The chunk `id` shared by the call (start) and result (completion) chunks. */
  id: string;
  /** Tool name (`delta.tool_calls[].function.name`). */
  name: string;
  /** Call-chunk timestamp (epoch ms, magnitude-normalized). */
  startedAtMs: number;
  /** Result-chunk timestamp (epoch ms) when the pair completed, else undefined. */
  endedAtMs?: number;
  /** `endedAtMs - startedAtMs` when both are present, else 0. */
  durationMs: number;
  /** `false` only when a `role:tool` result explicitly signalled an error. */
  success: boolean;
  /** `run_setup` infrastructure ops (clone, MCP-server starts) — excluded from tool metrics. */
  isSetup: boolean;
}

/** Disjoint token usage summed from `usage` chunks, when the CAPI emitted any. */
export interface CloudLogTokenUsage {
  /** Fresh (non-cache-read) input = Σ(prompt_tokens − cached_tokens). Disjoint from cached. */
  inputTokens: number;
  /** Σ cached_tokens (prompt_tokens_details.cached_tokens). */
  cachedTokens: number;
  /** Σ completion_tokens. */
  outputTokens: number;
}

/** The normalized result of parsing one session's CAPI SSE log. */
export interface ParsedCloudLog {
  /**
   * Real user-request texts in stream order. The platform-injected housekeeping
   * prompt (PR title/description) is EXCLUDED. Bare `role:user` messages carry no
   * timestamp, so this preserves order only.
   */
  userRequests: string[];
  /** Distinct tool invocations (call/result paired by chunk id), in start order. */
  toolInvocations: CloudToolInvocation[];
  /** Assistant final answer — the `finish_reason:"stop"` chunk content, when present. */
  finalResponse?: string;
  /** Summed disjoint token usage when `usage` chunks were present, else undefined. */
  tokenUsage?: CloudLogTokenUsage;
  /** Distinct LLM turns (the platform turn counter approximation). */
  llmTurns: number;
  /** Lines/chunks skipped as unknown shapes — diagnostics only; never fails the parse. */
  skipped: number;
}

// ---------------------------------------------------------------------------
// cloudMapper input
// ---------------------------------------------------------------------------

/** Everything the mapper needs to build the shared model shapes for ONE session. */
export interface CloudSessionInput {
  taskId: string;
  taskName: string;
  taskState: CloudTaskState | string;
  /** The raw session payload (authoritative for prompt/model/timestamps/credits). */
  session: RawCloudSession;
  /** Sanitized repository URL (`https://github.com/owner/repo`) or `unknown`. */
  repository: string;
  /** Parsed CAPI log for this session, when it has been fetched (Phase 2 depth). */
  log?: ParsedCloudLog;
  /** Wall-clock now (ms) for non-terminal session duration. Injected for tests. */
  nowMs: number;
  /** Optional external URL for the "Open on GitHub" header link. */
  externalUrl?: string;
  /**
   * Optional disambiguation suffix appended to the session title when a task has
   * multiple sessions (steer follow-ups), e.g. ` — session 2/3`. The source sets
   * it once it knows the sibling count; absent for single-session tasks.
   */
  sessionLabelSuffix?: string;
}

// ---------------------------------------------------------------------------
// Sink (on-disk store) shapes
// ---------------------------------------------------------------------------

/** Per-account poll health, written by the leaseholder, read by every window. */
export interface CloudAccountStatus {
  login: string;
  /** `ok` on success, else a FailureReason-ish string (`unauthenticated`, `network`, …). */
  lastOutcome: string;
  lastErrorMessage?: string;
  authSource: CloudAuthSource;
}

/** Poller health record embedded in the sink index. */
export interface CloudPollerStatus {
  lastPollAtMs: number;
  firstPollCompleted: boolean;
  accounts: CloudAccountStatus[];
}

/** A parsed-summary cache entry per task (so reader windows avoid re-reading raw). */
export interface CloudTaskIndexEntry {
  taskId: string;
  /** The account (login) that fetched this task. */
  account: string;
  /** Resolved repository URL or `unknown`. */
  repository: string;
  /** Latest known task state. */
  state: CloudTaskState | string;
  /** Session ids belonging to this task. */
  sessionIds: string[];
  /** Latest `updated_at`/`created_at` for the task (epoch ms). */
  updatedAtMs: number;
  /** Whether the task is terminal (its session logs are immutable). */
  terminal: boolean;
}

/** The versioned sink index (`index.json`). */
export interface SinkIndex {
  /** On-disk schema version for the index file itself. */
  version: number;
  /** Parser version — bumping it invalidates derived data (re-parse raw). */
  parserVersion: number;
  /** Newest task `updated_at` seen (epoch ms) — the poll watermark. */
  watermarkMs: number;
  poller: CloudPollerStatus;
  /** Per-task parsed-summary cache, keyed by task id. */
  tasks: Record<string, CloudTaskIndexEntry>;
}

/** Bump when the SSE/mapper derivation changes so old derived data is re-parsed. */
export const CLOUD_PARSER_VERSION = 1;
/** Bump when the on-disk index schema itself changes. */
export const CLOUD_SINK_INDEX_VERSION = 1;

// ---------------------------------------------------------------------------
// Config seam (satisfied structurally by `Configuration`)
// ---------------------------------------------------------------------------

/** The config surface the cloud poller + source read (a `Configuration` subset). */
export interface CloudConfig {
  isCopilotCloudEnabled(): boolean;
  getCopilotCloudAccounts(): string[];
  getCopilotCloudGhCliPath(): string;
  getCopilotCloudIdlePollMs(): number;
  getCopilotCloudActivePollMs(): number;
  getCopilotCloudScope(): 'my-tasks' | 'repos';
  getCopilotCloudRetentionMs(): number;
  getCopilotCloudMaxTasks(): number;
  /** Repositories hidden from the whole extension (optional; `?? empty`). */
  getExcludedRepositories?(): ReadonlySet<string>;
}

/**
 * Normalize the mixed-magnitude `created` timestamps seen in the SSE stream:
 * most chunks are unix *seconds*, a few (MCP-start events from a different
 * producer) are unix *milliseconds*. Values `> 1e12` are already ms.
 */
export function normalizeEpochMs(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return value > 1e12 ? Math.floor(value) : Math.floor(value * 1000);
}

/** Strip the CAPI model prefix (e.g. `sweagent-capi:claude-sonnet-4.6` → `claude-sonnet-4.6`). */
export function stripCloudModelPrefix(model: string | undefined): string {
  if (model === undefined) {
    return 'unknown';
  }
  const trimmed = model.trim();
  if (trimmed.length === 0 || trimmed.toLowerCase() === 'unknown') {
    return 'unknown';
  }
  const colon = trimmed.indexOf(':');
  return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
}

/** Parse an RFC3339 timestamp (with optional nanos) to epoch ms, else undefined. */
export function rfc3339ToMs(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
