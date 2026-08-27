/**
 * Background puller for autonomous Copilot CLI agent OTLP — the archiver-pattern
 * loop (NOT LiveSource-dependent), mirroring {@link ../cloud/cloudAgentPoller.CloudAgentPoller}.
 * Constructed + started in `activate()` gated only on `copilotAgent.enabled`; one
 * window pulls via a {@link ../otel/writerLease.WriterLease} (heartbeat 30 s /
 * staleMs 90 s, decoupled from the poll cadence so a crashed leader fails over
 * fast). Reader windows never pull — they learn of changes from the sink's
 * `index.json` mtime.
 *
 * Each poll (leader only): list batches newer than the watermark → for each not
 * yet ingested, download the raw OTLP → decode via the shared `decodeTraceRequest`
 * (so the resource-attribute copying + Copilot-schema mapping are identical to the
 * live receiver) → write spans to the sink's `ingest.db` → archive the raw batch →
 * advance the watermark (never past an un-ingested batch) → prune spans + raw to
 * retention. The SQLite writer is opened ONLY while the lease is held and closed
 * at the end of the poll, so readers (which snapshot the file) never contend.
 *
 * Errors are recorded in the index's puller status (so the source can surface the
 * last failure) and routed to `onError`, never thrown into the host.
 */

import { WriterLease, WriterLeaseClock } from '../otel/writerLease';
import { IngestStore } from '../otel/ingestStore';
import { SpanRows } from '../otel/otlpToRows';
import { decodeTraceRequest } from '../otel/otlpReceiver';
import type { FailureReason } from '../telemetry/telemetryService';
import { AgentBatchReader, AgentConfig, AgentPullerStatus, AgentSinkIndex } from './agentTypes';
import { AgentSink } from './agentSink';

/** Lease heartbeat cadence + staleness — decoupled from the poll cadence. */
const HEARTBEAT_MS = 30_000;
const STALE_MS = 90_000;

/** The subset of {@link IngestStore} the puller needs (injectable for tests). */
export interface IngestWriter {
  writeSpans(rows: SpanRows): number;
  prune(maxAgeMs: number, nowMs: number): number;
  close(): void;
}

export interface AgentPullerDeps {
  config: AgentConfig;
  reader: AgentBatchReader;
  sink: AgentSink;
  /** Fired after a poll that ingested at least one new batch. */
  onIngest: () => void;
  onError?: (err: unknown) => void;
  /** Fired once when THIS window becomes the pulling leader (acquires the lease). */
  onBecomeLeader?: () => void;
  /** Fired once when THIS window steps down / starts as a follower. */
  onBecomeReader?: () => void;
  now?: () => number;
  /** Injectable lease factory (tests). */
  leaseFactory?: (lockPath: string, staleMs: number, clock: WriterLeaseClock) => WriterLease;
  /** Injectable ingest-DB writer factory (tests); defaults to a real {@link IngestStore}. */
  storeFactory?: (dbPath: string) => IngestWriter;
  /** Injectable OTLP decoder (tests); defaults to the shared {@link decodeTraceRequest}. */
  decode?: (body: string) => SpanRows;
}

/** Summary of one poll, returned for tests + cadence decisions. */
export interface AgentPullOutcome {
  /** Whether this window actually pulled (false when it isn't the leaseholder / disabled). */
  polled: boolean;
  /** Whether new batches were ingested. */
  changed: boolean;
  /** Number of batches ingested this poll. */
  pulled: number;
  /** `ok`, or the taxonomy failure of the pull. */
  outcome: 'ok' | FailureReason;
}

export class AgentPuller {
  private readonly now: () => number;
  private readonly storeFactory: (dbPath: string) => IngestWriter;
  private readonly decode: (body: string) => SpanRows;
  private lease: WriterLease | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastOutcome: AgentPullOutcome | undefined;
  private inFlight: Promise<AgentPullOutcome> | undefined;
  private role: 'leader' | 'reader' | undefined;

  constructor(private readonly deps: AgentPullerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.storeFactory = deps.storeFactory ?? ((p) => new IngestStore(p));
    this.decode = deps.decode ?? ((body) => decodeTraceRequest(Buffer.from(body, 'utf8')));
  }

  /** Elect the writer, start the heartbeat, and run the first poll immediately. */
  start(): void {
    this.stopped = false;
    this.ensureLease();
    this.beat();
    this.heartbeatTimer = setInterval(() => this.beat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
    this.scheduleNextPoll(0);
  }

  private ensureLease(): void {
    if (this.lease !== undefined || this.stopped) {
      return;
    }
    this.deps.sink.ensureDirs();
    const factory =
      this.deps.leaseFactory ?? ((lock, stale, clock) => new WriterLease(lock, stale, clock));
    this.lease = factory(this.deps.sink.lockPath(), STALE_MS, { now: this.now });
  }

  /** Stop timers and release the lease. */
  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }
    this.lease?.release();
    this.lease = undefined;
  }

  /** Kick an immediate poll (the Refresh command / manual refresh path). */
  refresh(): void {
    this.scheduleNextPoll(0);
  }

  private beat(): void {
    this.lease?.tryAcquire();
    this.syncLeaseRole();
  }

  /** Announce a polling-role change exactly once per transition. */
  private syncLeaseRole(): void {
    const next: 'leader' | 'reader' = (this.lease?.isHeld ?? false) ? 'leader' : 'reader';
    if (this.role === next) {
      return;
    }
    this.role = next;
    if (next === 'leader') {
      this.deps.onBecomeLeader?.();
    } else {
      this.deps.onBecomeReader?.();
    }
  }

  private scheduleNextPoll(delayMs: number): void {
    if (this.stopped) {
      return;
    }
    if (this.pollTimer !== undefined) {
      clearTimeout(this.pollTimer);
    }
    this.pollTimer = setTimeout(() => {
      void this.pollOnce()
        .catch((err) => this.deps.onError?.(err))
        .finally(() => this.scheduleNextPoll(this.currentCadenceMs()));
    }, delayMs);
    this.pollTimer.unref?.();
  }

  /** Faster cadence right after a poll that pulled new batches, else the idle cadence. */
  currentCadenceMs(): number {
    return this.lastOutcome?.changed
      ? this.deps.config.getCopilotAgentActivePollMs()
      : this.deps.config.getCopilotAgentIdlePollMs();
  }

  /** Run one poll. Coalesces concurrent callers; never throws. */
  pollOnce(): Promise<AgentPullOutcome> {
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    this.inFlight = this.runPoll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private record(outcome: AgentPullOutcome): AgentPullOutcome {
    this.lastOutcome = outcome;
    return outcome;
  }

  private async runPoll(): Promise<AgentPullOutcome> {
    const idle: AgentPullOutcome = { polled: false, changed: false, pulled: 0, outcome: 'ok' };
    if (this.stopped || !this.deps.config.isCopilotAgentEnabled()) {
      return this.record(idle);
    }
    if (this.deps.config.getCopilotAgentEndpoint() === undefined) {
      return this.record(idle); // no landing spot configured — nothing to pull
    }
    this.ensureLease();
    // Reader windows never pull — the leader owns the sink. Decide ownership once
    // here (before any network call) so followers make ZERO requests.
    const held = this.lease === undefined || this.lease.tryAcquire();
    this.syncLeaseRole();
    if (!held) {
      return this.record(idle);
    }

    const index = this.deps.sink.readIndex();
    const prevPuller = index.puller;
    const now = this.now();
    const max = this.deps.config.getCopilotAgentMaxSessions();
    const retentionMs = this.deps.config.getCopilotAgentRetentionMs();

    const listed = await this.deps.reader.listBatches(index.watermarkMs, max);
    let changed = false;
    let pulled = 0;
    let outcome: 'ok' | FailureReason = 'ok';
    let errorMessage: string | undefined;

    if (!listed.ok) {
      outcome = listed.reason;
      errorMessage = listed.message;
      this.deps.onError?.(new Error(listed.message));
    } else {
      const store = this.storeFactory(this.deps.sink.ingestDbPath());
      let maxProcessedMs = index.watermarkMs;
      let minFailedMs = Number.POSITIVE_INFINITY;
      try {
        for (const ref of listed.value) {
          if (index.batches[ref.id] !== undefined) {
            maxProcessedMs = Math.max(maxProcessedMs, ref.createdAtMs);
            continue; // already ingested — dedupe by stable batch id
          }
          const dl = await this.deps.reader.downloadBatch(ref);
          if (!dl.ok) {
            minFailedMs = Math.min(minFailedMs, ref.createdAtMs);
            this.deps.onError?.(new Error(`batch ${ref.id}: ${dl.message}`));
            continue;
          }
          const written = store.writeSpans(this.decode(dl.value));
          this.deps.sink.writeBatchRaw(ref.service, ref.id, dl.value);
          index.batches[ref.id] = {
            batchId: ref.id,
            service: ref.service,
            createdAtMs: ref.createdAtMs,
            ingestedAtMs: now,
            spanCount: written,
          };
          maxProcessedMs = Math.max(maxProcessedMs, ref.createdAtMs);
          changed = true;
          pulled++;
        }
        store.prune(retentionMs, now);
      } finally {
        store.close();
      }
      this.deps.sink.pruneRaw(retentionMs, now);
      // Advance the watermark, but NEVER past a batch that failed to download this
      // poll (keep it below the oldest failure so the next list re-surfaces it).
      let watermarkMs = maxProcessedMs;
      if (Number.isFinite(minFailedMs)) {
        watermarkMs = Math.min(watermarkMs, minFailedMs - 1);
      }
      index.watermarkMs = Math.max(index.watermarkMs, watermarkMs);
    }

    const nextPuller: AgentPullerStatus = {
      lastPullAtMs: now,
      firstPullCompleted: true,
      lastOutcome: outcome,
      lastErrorMessage: errorMessage,
    };
    index.puller = nextPuller;

    // If stopped mid-poll, don't write (another window may now be the leader).
    if (this.stopped) {
      return this.record({ polled: true, changed, pulled, outcome });
    }
    // Only rewrite the index when spans changed OR the puller status changed, so a
    // steady no-op poll never churns index.json's mtime (which would wake readers).
    if (changed || pullerStatusChanged(prevPuller, nextPuller)) {
      this.deps.sink.writeIndex(index);
    }
    if (changed) {
      this.deps.onIngest();
    }
    return this.record({ polled: true, changed, pulled, outcome });
  }
}

/** Whether the puller status changed in a way worth persisting (ignores the timestamp). */
function pullerStatusChanged(a: AgentPullerStatus, b: AgentPullerStatus): boolean {
  return (
    a.firstPullCompleted !== b.firstPullCompleted ||
    a.lastOutcome !== b.lastOutcome ||
    a.lastErrorMessage !== b.lastErrorMessage
  );
}

/** Re-exported for tests that want to assert on the index shape. */
export type { AgentSinkIndex };
