import { AggregateBatch } from '../aggregate/models';
import { AggregationRow, buildBatch } from '../aggregate/aggregator';
import { computeDeveloperId, getIdentityInput } from '../aggregate/pseudonymizer';
import { buildRepoCustomizationIndex } from '../aggregate/customizationFilter';
import {
  extractContextObservations,
  sessionsFromAggregationRows,
} from '../aggregate/contextInsightsExtractor';
import { buildContextInsightsBatch } from '../aggregate/contextInsightsAggregator';
import { computeCanSync, describeSyncBlock } from '../consent/syncGate';
import { DiscoveryEventRow } from '../context/discoveryParser';
import { SyncClient, SyncOutcome, isTransient } from './syncClient';
import { SyncRun, SyncRunOutcome, SyncStateStore } from './syncState';

/**
 * The orchestrator that turns local telemetry into uploaded aggregate batches
 * (Phase 7). It is the SINGLE place a network upload originates, and it is gated
 * twice: explicit consent AND a stored API key (the shared `computeCanSync` gate).
 *
 * Determinism + testability:
 *  - All collaborators are injected behind tiny interfaces (config, consent,
 *    secrets, telemetry, client, state) so the engine runs headless under vitest
 *    with fakes and never imports `vscode`.
 *  - Time is injected via a {@link Clock}; the engine NEVER calls `Date.now()`
 *    directly, so window math + backoff are fully deterministic in tests.
 *
 * Idempotency: re-sending an overlapping window is SAFE — the server upserts by
 * `rowKey`, and `buildBatch` is deterministic (same rows/window/dev id => same
 * `batchId` + `rowKey`s). The watermark is an optimization to avoid needless
 * re-sends, NOT a correctness requirement: on a permanent failure we leave it
 * unchanged so the window is retried next run.
 */

/** A monotone-ish wall clock seam (epoch ms). Injected so tests are deterministic. */
export interface Clock {
  nowMs(): number;
}

/** The real clock: the system wall-clock epoch ms. */
export const systemClock: Clock = { nowMs: () => Date.now() };

/** Config surface the engine reads (satisfied by {@link Configuration}). */
export interface SyncEngineConfig {
  getDashboardUrl(): string;
  isSyncEnabled(): boolean;
}

/** Consent surface the engine reads (satisfied by {@link ConsentManager}). */
export interface SyncConsent {
  isConsented(): boolean;
}

/** Secret surface the engine reads (satisfied by {@link SecretManager}). */
export interface SyncSecrets {
  hasApiKey(): Promise<boolean>;
  getOrCreatePseudonymSalt(): Promise<string>;
}

/** Telemetry surface the engine reads (satisfied by {@link TelemetryService}). */
export interface SyncTelemetry {
  getAggregationRows(
    sinceMs?: number,
    untilMs?: number,
  ): { ok: true; value: AggregationRow[] } | { ok: false; reason: string; message: string };
}

/**
 * Optional LOCAL-ONLY source for the context-insights upload (Phase: context
 * hotspots). When injected, the engine builds and sends a SEPARATE, additive
 * context-insights batch for the same window as the aggregate batch; when
 * absent, the engine behaves exactly as before (aggregate-only). Both methods
 * read on-machine data only and never emit raw content.
 */
export interface SyncContextInsightsSource {
  /** Discovery/customization events for one session (empty when none/unavailable). */
  getDiscoveryEvents(sessionKey: string): readonly DiscoveryEventRow[];
  /**
   * The subset of `sessionKeys` the LOCAL workflow-deviation detector flagged.
   * Returns an empty set when no workflows are configured. Used ONLY to count
   * deviation co-occurrence per file (never to transmit deviation details).
   */
  getDeviationSessionKeys(sessionKeys: readonly string[]): ReadonlySet<string>;
}

/** Tuning knobs for the retry/backoff loop. Defaults are sensible for prod. */
export interface SyncEngineOptions {
  /** Extension semver stamped into the batch `toolVersion`. */
  toolVersion: string;
  /** Optional workspace dir for git-email identity resolution. */
  workspaceCwd?: string;
  /** Optional VS Code machineId fallback for identity resolution. */
  machineId?: string;
  /** Max total send attempts (initial + retries) for transient failures. */
  maxAttempts?: number;
  /** Base backoff in ms (exponential: base * 2^(attempt-1)). */
  baseBackoffMs?: number;
  /** Upper bound on any single backoff delay (ms). */
  maxBackoffMs?: number;
  /**
   * Async sleeper, injected so tests can run without real timers. Defaults to a
   * real `setTimeout`-based delay. Receives the computed delay in ms.
   */
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic jitter source in [0,1). Defaults to `Math.random`. */
  random?: () => number;
}

/** The 30-minute bin width (ms), matching the aggregate engine's bucket width. */
const BIN_MS = 30 * 60 * 1000;

const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_BASE_BACKOFF_MS = 1000;
const DEFAULT_MAX_BACKOFF_MS = 30_000;

/** Structured result the command/view renders. */
export type SyncResult =
  | { status: 'blocked'; reason: string }
  | { status: 'upToDate' }
  | {
      status: 'success';
      bucketsSent: number;
      windowStartMs: number;
      windowEndMs: number;
      batchId: string;
    }
  | {
      status: 'failed';
      outcome: SyncOutcome;
      message: string;
      windowStartMs: number;
      windowEndMs: number;
    };

/** Inputs to {@link SyncEngine.runSync}. */
export interface RunSyncInput {
  /** True for a user-invoked Sync Now, false for background scheduler ticks. */
  manual: boolean;
}

export class SyncEngine {
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  /** Guards against overlapping runs (manual click during a background tick). */
  private inFlight: Promise<SyncResult> | undefined;

  constructor(
    private readonly config: SyncEngineConfig,
    private readonly consent: SyncConsent,
    private readonly secrets: SyncSecrets,
    private readonly telemetry: SyncTelemetry,
    private readonly client: SyncClient,
    private readonly state: SyncStateStore,
    private readonly clock: Clock,
    private readonly options: SyncEngineOptions,
    /**
     * Optional context-insights source. When omitted (e.g. in aggregate-only
     * tests), the secondary context-insights upload is skipped entirely.
     */
    private readonly contextInsights?: SyncContextInsightsSource,
  ) {
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseBackoffMs = options.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
    this.maxBackoffMs = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;
  }

  /**
   * Run one sync cycle. Serializes concurrent calls so a manual Sync Now and a
   * background tick never double-send the same window.
   */
  async runSync(input: RunSyncInput): Promise<SyncResult> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    const run = this.runSyncInner(input).finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private async runSyncInner(_input: RunSyncInput): Promise<SyncResult> {
    // a. GATE — never build or send anything when the gate is closed.
    const gateState = {
      consented: this.consent.isConsented(),
      hasApiKey: await this.secrets.hasApiKey(),
    };
    if (!computeCanSync(gateState)) {
      const reason = describeSyncBlock(gateState) ?? 'Sync is not permitted.';
      // Record the blocked run so the history shows why nothing was sent.
      await this.record({
        startedAtMs: this.clock.nowMs(),
        windowStartMs: 0,
        windowEndMs: 0,
        bucketsSent: 0,
        outcome: 'blocked',
        message: reason,
      });
      return { status: 'blocked', reason };
    }

    // Misconfiguration short-circuit: with no dashboard URL there is nowhere to
    // send, so do not bother building a batch. (The client also guards this, but
    // failing early here keeps the UX clear and avoids needless work.)
    const end = floorToBinMs(this.clock.nowMs());
    if (this.config.getDashboardUrl().trim().length === 0) {
      const message = outcomeMessage({ kind: 'misconfigured' });
      await this.record({
        startedAtMs: this.clock.nowMs(),
        windowStartMs: 0,
        windowEndMs: end,
        bucketsSent: 0,
        outcome: 'misconfigured',
        message,
      });
      return { status: 'failed', outcome: { kind: 'misconfigured' }, message, windowStartMs: 0, windowEndMs: end };
    }

    // b. WINDOW — [start, end) where end is floored to the current 30-min boundary
    // so only COMPLETED bins are sent (avoid re-sending a still-open current bin).
    const rowsResult = this.telemetry.getAggregationRows();
    if (!rowsResult.ok) {
      // Telemetry unavailable — surface as a (permanent-for-now) failure without a
      // network attempt. Treated like a serverError-style local condition.
      const message = rowsResult.message;
      const failure: SyncResult = {
        status: 'failed',
        outcome: { kind: 'serverError', status: 0 },
        message,
        windowStartMs: 0,
        windowEndMs: end,
      };
      await this.record(this.runFromResult(failure, 0));
      return failure;
    }
    const allRows = rowsResult.value;

    const watermark = this.state.getWatermarkMs();
    const start = watermark ?? earliestRowStartMs(allRows, end);

    if (start >= end) {
      await this.record({
        startedAtMs: this.clock.nowMs(),
        windowStartMs: start,
        windowEndMs: end,
        bucketsSent: 0,
        outcome: 'upToDate',
      });
      return { status: 'upToDate' };
    }

    // c. BUILD — only the rows inside [start, end). buildBatch re-bins/skips, but
    // we pre-filter so the batch window matches the rows it carries.
    const rows = allRows.filter((r) => r.startTimeMs >= start && r.startTimeMs < end);
    const saltHex = await this.secrets.getOrCreatePseudonymSalt();
    const identity = getIdentityInput(this.options.workspaceCwd, this.options.machineId);
    const developerId = computeDeveloperId(saltHex, identity.input);
    const batch: AggregateBatch = buildBatch({
      rows,
      pseudonymousDeveloperId: developerId,
      toolVersion: this.options.toolVersion,
      windowStartMs: start,
      windowEndMs: end,
      generatedAtMs: this.clock.nowMs(),
    });

    // d. SEND with retry/backoff on transient outcomes only.
    const outcome = await this.sendWithRetry(() => this.client.sendBatch(batch));
    const bucketsSent = batch.buckets.length;

    if (outcome.kind === 'success') {
      // e. advance the watermark, record the run, best-effort status report.
      await this.state.setWatermarkMs(end);
      await this.record({
        startedAtMs: this.clock.nowMs(),
        windowStartMs: start,
        windowEndMs: end,
        bucketsSent,
        outcome: 'success',
      });
      await this.client.reportStatus({
        toolVersion: this.options.toolVersion,
        lastOutcome: 'success',
        reportedAtMs: this.clock.nowMs(),
        bucketsSent,
        windowStartMs: start,
        windowEndMs: end,
      });
      // f. SECONDARY, best-effort context-insights upload for the same window.
      // Never affects the aggregate result: failures are swallowed internally.
      await this.trySendContextInsights(rows, start, end, developerId);
      return { status: 'success', bucketsSent, windowStartMs: start, windowEndMs: end, batchId: batch.batchId };
    }

    // Permanent (or retries-exhausted) failure — leave the watermark UNCHANGED so
    // the same window is retried next run (idempotent on the server).
    const message = outcomeMessage(outcome);
    await this.record({
      startedAtMs: this.clock.nowMs(),
      windowStartMs: start,
      windowEndMs: end,
      bucketsSent: 0,
      outcome: outcome.kind as SyncRunOutcome,
      message,
    });
    return { status: 'failed', outcome, message, windowStartMs: start, windowEndMs: end };
  }

  /**
   * Send the batch, retrying ONLY transient outcomes (network/serverError/
   * rateLimited) up to {@link maxAttempts} with exponential backoff + jitter.
   * 429 honors `retryAfterMs`. Permanent outcomes (unauthorized/rejected/disabled/
   * misconfigured) return immediately. The actual transport is injected via
   * `send` so the same loop drives both the aggregate and context-insights POSTs.
   */
  private async sendWithRetry(send: () => Promise<SyncOutcome>): Promise<SyncOutcome> {
    let lastOutcome: SyncOutcome = { kind: 'network', message: 'No attempt made.' };
    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      lastOutcome = await send();
      if (!isTransient(lastOutcome)) {
        return lastOutcome; // success OR a permanent failure — stop now.
      }
      if (attempt >= this.maxAttempts) {
        break; // exhausted retries on a transient failure.
      }
      await this.sleep(this.backoffMs(attempt, lastOutcome));
    }
    return lastOutcome;
  }

  /**
   * Build and send the SEPARATE context-insights batch for `[start, end)` using
   * the same already-passed gate, window, and developer id as the aggregate
   * batch. Best-effort and fully isolated: any failure (including a throw from
   * the local filesystem index walk or detector) is swallowed so the aggregate
   * sync result is never affected. No-op when no context-insights source was
   * injected, when there are no rows, or when nothing resolves to a repo-scoped
   * customization file.
   */
  private async trySendContextInsights(
    rows: AggregationRow[],
    start: number,
    end: number,
    developerId: string,
  ): Promise<void> {
    const source = this.contextInsights;
    if (source === undefined || rows.length === 0) {
      return;
    }
    try {
      const sessionKeys = distinctSessionKeys(rows);
      const deviationSessions = source.getDeviationSessionKeys(sessionKeys);
      const sessions = sessionsFromAggregationRows(rows, deviationSessions);
      const index = buildRepoCustomizationIndex(this.options.workspaceCwd);
      const observations = extractContextObservations(
        sessions,
        (key) => source.getDiscoveryEvents(key),
        this.options.workspaceCwd,
        index,
      );
      if (observations.length === 0) {
        return; // nothing repo-scoped to report — skip an empty upload.
      }
      const batch = buildContextInsightsBatch({
        observations,
        pseudonymousDeveloperId: developerId,
        toolVersion: this.options.toolVersion,
        windowStartMs: start,
        windowEndMs: end,
        generatedAtMs: this.clock.nowMs(),
      });
      await this.sendWithRetry(() => this.client.sendContextInsights(batch));
    } catch {
      // Best-effort: a context-insights failure must never break aggregate sync.
    }
  }

  /** Compute the backoff delay (ms) before the next attempt. */
  private backoffMs(attempt: number, outcome: SyncOutcome): number {
    // Honor a server-provided Retry-After on 429 (clamped to the max backoff).
    if (outcome.kind === 'rateLimited' && outcome.retryAfterMs !== undefined) {
      return Math.min(this.maxBackoffMs, Math.max(0, outcome.retryAfterMs));
    }
    const exp = this.baseBackoffMs * Math.pow(2, attempt - 1);
    const capped = Math.min(this.maxBackoffMs, exp);
    // Full jitter in [0, capped] to de-correlate retries across many clients.
    return Math.floor(this.random() * capped);
  }

  private async record(run: SyncRun): Promise<void> {
    await this.state.recordRun(run);
  }

  private runFromResult(failure: Extract<SyncResult, { status: 'failed' }>, bucketsSent: number): SyncRun {
    return {
      startedAtMs: this.clock.nowMs(),
      windowStartMs: failure.windowStartMs,
      windowEndMs: failure.windowEndMs,
      bucketsSent,
      outcome: failure.outcome.kind as SyncRunOutcome,
      message: failure.message,
    };
  }
}

/** Floor an epoch-ms timestamp to its 30-minute bin boundary (epoch ms). */
function floorToBinMs(timeMs: number): number {
  return Math.floor(timeMs / BIN_MS) * BIN_MS;
}

/**
 * The earliest row start (epoch ms) among `rows`, floored to its bin so the first
 * window aligns to a bin boundary. When there are no rows, default to `end` so the
 * engine reports `upToDate` (an empty window) rather than inventing a range.
 */
function earliestRowStartMs(rows: AggregationRow[], end: number): number {
  let min: number | undefined;
  for (const r of rows) {
    if (min === undefined || r.startTimeMs < min) {
      min = r.startTimeMs;
    }
  }
  return min === undefined ? end : floorToBinMs(min);
}

/** The distinct, non-empty session keys present in `rows`, order-preserving. */
function distinctSessionKeys(rows: readonly AggregationRow[]): string[] {
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const r of rows) {
    if (r.sessionKey.length > 0 && !seen.has(r.sessionKey)) {
      seen.add(r.sessionKey);
      keys.push(r.sessionKey);
    }
  }
  return keys;
}

/** A short, key-free message describing a failure outcome for the history/UI. */
function outcomeMessage(outcome: SyncOutcome): string {
  switch (outcome.kind) {
    case 'unauthorized':
      return 'API key was rejected (invalid, revoked, or not permitted). Update your organization API key.';
    case 'rejected':
      return `The server rejected the batch: ${outcome.detail}`;
    case 'disabled':
      return 'Cloud ingestion is currently disabled on the server.';
    case 'serverError':
      return outcome.status > 0
        ? `The server returned an error (status ${outcome.status}). It was retried and will be retried again next sync.`
        : 'Local telemetry could not be read for sync.';
    case 'rateLimited':
      return 'The server is rate limiting uploads. It will be retried on the next sync.';
    case 'network':
      return `Could not reach the dashboard: ${outcome.message}`;
    case 'misconfigured':
      return 'No dashboard URL and/or API key is configured.';
    default:
      return 'Sync failed.';
  }
}

/** Real timer-based sleep used outside tests. */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
