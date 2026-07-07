/**
 * Background poller for Copilot cloud coding-agent tasks — the archiver-pattern
 * loop (NOT LiveSource-dependent). Constructed + started in `activate()` gated
 * only on `copilotCloud.enabled`; one window polls via a {@link WriterLease}
 * (heartbeat 30 s / staleMs 90 s, decoupled from the 60–300 s poll cadence so a
 * crashed leader fails over fast). Reader windows never run `gh`; they learn of
 * changes from the sink's `index.json` (fs.watch, wired in `extension.ts`).
 *
 * Each poll, per configured account: resolve auth → list tasks → fetch each
 * task's detail + resolve its repo + fetch each session's log (terminal logs
 * once, non-terminal re-fetched) → rebuild the index (watermark + per-task
 * summary + per-account status). Everything is stored raw; the source applies
 * repository exclusion + mapping. Errors are recorded per account (so one expired
 * token never hides another account's healthy data) and routed to `onError`,
 * never thrown into the host.
 */

import { WriterLease, WriterLeaseClock } from '../otel/writerLease';
import { sanitizeRepositoryUrl } from '../telemetry/repositoryUrl';
import {
  CloudAccountAuth,
  CloudAccountStatus,
  CloudConfig,
  CloudTaskIndexEntry,
  RawCloudTaskDetail,
  SinkIndex,
  isTerminalCloudState,
  rfc3339ToMs,
} from './cloudTypes';
import { CloudApiClient } from './cloudApiClient';
import { CloudSink } from './cloudSink';
import { GhAuth } from './ghAuth';

/** Lease heartbeat cadence + staleness — decoupled from the poll cadence (plan §2.2). */
const HEARTBEAT_MS = 30_000;
const STALE_MS = 90_000;
/** Extra delay applied after a rate-limited poll. */
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

export interface CloudAgentPollerDeps {
  config: CloudConfig;
  auth: GhAuth;
  client: CloudApiClient;
  sink: CloudSink;
  /** Fired after a poll that changed the task set / any task state. */
  onIngest: () => void;
  onError?: (err: unknown) => void;
  now?: () => number;
  /** Injectable lease factory (tests). */
  leaseFactory?: (lockPath: string, staleMs: number, clock: WriterLeaseClock) => WriterLease;
}

/** Summary of one poll, returned for tests + cadence decisions. */
export interface PollOutcome {
  /** Whether this window actually polled (false when it isn't the leaseholder). */
  polled: boolean;
  /** Whether the index changed (new task, state change, or new log). */
  changed: boolean;
  /** Whether any surfaced task is non-terminal (drives the faster active cadence). */
  anyNonTerminal: boolean;
  /** Whether any account hit a rate limit (drives backoff). */
  rateLimited: boolean;
  accounts: CloudAccountStatus[];
}

export class CloudAgentPoller {
  private readonly now: () => number;
  private lease: WriterLease | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private lastOutcome: PollOutcome | undefined;
  /** In-flight poll, so concurrent callers coalesce instead of double-polling. */
  private inFlight: Promise<PollOutcome> | undefined;

  constructor(private readonly deps: CloudAgentPollerDeps) {
    this.now = deps.now ?? (() => Date.now());
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

  /** Create the writer lease lazily (also lets tests drive pollOnce without start()). */
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

  /**
   * Kick an immediate poll (the Refresh command / manual refresh path). Also
   * invalidates cached auth so a just-set token / re-login takes effect now rather
   * than after the (up to 10-minute) auth-cache TTL.
   */
  refresh(): void {
    this.deps.auth.invalidate();
    this.scheduleNextPoll(0);
  }

  /** Refresh the heartbeat (doubles as re-election when not held). */
  private beat(): void {
    this.lease?.tryAcquire();
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

  /** The next poll delay: active when a task is running, plus rate-limit backoff. */
  currentCadenceMs(): number {
    const base = this.lastOutcome?.anyNonTerminal
      ? this.deps.config.getCopilotCloudActivePollMs()
      : this.deps.config.getCopilotCloudIdlePollMs();
    return this.lastOutcome?.rateLimited ? Math.max(base, RATE_LIMIT_BACKOFF_MS) : base;
  }

  /**
   * Run one poll. Returns a summary; records per-account status + writes the
   * index when it holds the lease. Never throws.
   */
  pollOnce(): Promise<PollOutcome> {
    // Coalesce concurrent callers (e.g. a manual refresh during an in-flight poll)
    // so we never fire duplicate gh API calls or lose read-modify-write index updates.
    if (this.inFlight !== undefined) {
      return this.inFlight;
    }
    this.inFlight = this.runPoll().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async runPoll(): Promise<PollOutcome> {
    const idle: PollOutcome = { polled: false, changed: false, anyNonTerminal: false, rateLimited: false, accounts: [] };
    if (this.stopped || !this.deps.config.isCopilotCloudEnabled()) {
      return this.record(idle);
    }
    this.ensureLease();
    // Reader windows never poll — the leader owns the sink.
    if (this.lease !== undefined && !this.lease.tryAcquire()) {
      return this.record(idle);
    }

    const index = this.deps.sink.readIndex();
    const accounts = this.deps.config.getCopilotCloudAccounts();
    const maxTasks = this.deps.config.getCopilotCloudMaxTasks();
    const scope = this.deps.config.getCopilotCloudScope();
    const statuses: CloudAccountStatus[] = [];
    let changed = false;
    let anyNonTerminal = false;
    let rateLimited = false;
    let watermarkMs = index.watermarkMs;

    for (const login of accounts) {
      const authResult = await this.deps.auth.resolveAccount(login);
      if (!authResult.ok) {
        statuses.push({ login, lastOutcome: authResult.reason, lastErrorMessage: authResult.message, authSource: 'gh' });
        if (authResult.reason === 'rateLimited') {
          rateLimited = true;
        }
        continue;
      }
      const auth = authResult.auth;

      // Seed the repo cache once from disk so ids resolve without re-fetching.
      this.deps.client.seedRepoCache(this.deps.sink.readRepos());

      const listed =
        scope === 'repos'
          ? await this.listRepoScopedTasks(auth, maxTasks)
          : await this.deps.client.listMyTasks(auth, maxTasks);
      if (!listed.ok) {
        statuses.push({ login, lastOutcome: listed.reason, lastErrorMessage: listed.message, authSource: auth.source });
        if (listed.reason === 'rateLimited') {
          rateLimited = true;
        }
        continue;
      }

      let accountRateLimited = false;
      for (const task of listed.value) {
        const detailResult = await this.deps.client.getTaskDetail(auth, task.id);
        if (!detailResult.ok) {
          if (detailResult.reason === 'rateLimited') {
            accountRateLimited = true;
            break;
          }
          this.deps.onError?.(new Error(`task ${task.id}: ${detailResult.message}`));
          continue;
        }
        const detail = detailResult.value;
        const repository = await this.resolveRepository(auth, detail);
        this.deps.sink.writeTaskRaw(detail.id, JSON.stringify(detail));

        const sessions = Array.isArray(detail.sessions) ? detail.sessions : [];
        const sessionIds: string[] = [];
        for (const session of sessions) {
          if (typeof session.id !== 'string') {
            continue;
          }
          sessionIds.push(session.id);
          const terminal = isTerminalCloudState((session.state ?? detail.state) as string | undefined);
          // Terminal logs are immutable — fetch once; non-terminal re-fetch each poll.
          if (terminal && this.deps.sink.hasSessionLog(session.id)) {
            continue;
          }
          const log = await this.deps.client.fetchSessionLog(auth, session.id);
          if (log.ok) {
            // Only rewrite (and signal a change) when the log actually differs, so a
            // non-terminal session polled repeatedly with identical bytes doesn't
            // churn the sink / fire onIngest every cycle.
            if (this.deps.sink.readSessionLog(session.id) !== log.value) {
              this.deps.sink.writeSessionLog(session.id, log.value);
              changed = true;
            }
          } else if (log.reason === 'rateLimited') {
            accountRateLimited = true;
            break;
          }
          // Other log failures (e.g. 404 on enterprise CAPI) degrade to metadata-only.
        }

        const state = (detail.state ?? 'queued') as string;
        const terminal = isTerminalCloudState(state) && sessions.every((s) => isTerminalCloudState((s.state ?? state) as string));
        if (!terminal) {
          anyNonTerminal = true;
        }
        const prevEntry = index.tasks[detail.id];
        // When the preview API omits timestamps (documented drift), fall back to the
        // PREVIOUS entry's timestamp (stable across polls), then 0 — NEVER this.now(),
        // which would make entryChanged() fire every poll (infinite refresh loop) and
        // ratchet the watermark to wall-clock.
        const updatedAtMs =
          rfc3339ToMs(detail.updated_at) ?? rfc3339ToMs(detail.created_at) ?? prevEntry?.updatedAtMs ?? 0;
        watermarkMs = Math.max(watermarkMs, updatedAtMs);
        const entry: CloudTaskIndexEntry = {
          taskId: detail.id,
          account: login,
          repository,
          state,
          sessionIds,
          updatedAtMs,
          terminal,
        };
        if (entryChanged(prevEntry, entry)) {
          changed = true;
        }
        index.tasks[detail.id] = entry;

        if (accountRateLimited) {
          break;
        }
      }

      if (accountRateLimited) {
        rateLimited = true;
        statuses.push({ login, lastOutcome: 'rateLimited', lastErrorMessage: 'GitHub API rate limited — backing off.', authSource: auth.source });
      } else {
        statuses.push({ login, lastOutcome: 'ok', authSource: auth.source });
      }
    }

    // The first successful poll always refreshes so the "first poll in progress"
    // row clears and the bucket populates.
    if (!index.poller.firstPollCompleted) {
      changed = true;
    }

    // If we were stopped mid-poll, don't write or refresh (another window may now
    // be the leader).
    if (this.stopped) {
      return this.record({ polled: true, changed, anyNonTerminal, rateLimited, accounts: statuses });
    }

    // Only rewrite the index when something actually changed (a new/updated task or
    // a changed account status). Rewriting on every no-op poll would churn
    // index.json's mtime, needlessly waking reader windows and busting the source's
    // mtime cache (a full re-parse + re-render every cycle).
    if (changed || !sameAccounts(index.poller.accounts, statuses)) {
      this.deps.sink.writeRepos(this.deps.client.knownRepos());
      const nextIndex: SinkIndex = {
        ...index,
        watermarkMs,
        poller: { lastPollAtMs: this.now(), firstPollCompleted: true, accounts: statuses },
      };
      this.deps.sink.writeIndex(nextIndex);
    }
    this.deps.sink.prune(this.deps.config.getCopilotCloudRetentionMs(), this.now());

    const outcome = this.record({ polled: true, changed, anyNonTerminal, rateLimited, accounts: statuses });
    if (changed) {
      this.deps.onIngest();
    }
    return outcome;
  }

  /** Scope `repos`: union tasks across the workspace repos (Phase 3). */
  private async listRepoScopedTasks(
    auth: CloudAccountAuth,
    maxTasks: number,
  ): Promise<Awaited<ReturnType<CloudApiClient['listMyTasks']>>> {
    // Phase 3 wires workspace repo owner/name here; until then fall back to my-tasks
    // so enabling `repos` scope never yields an empty view by accident.
    return this.deps.client.listMyTasks(auth, maxTasks);
  }

  /** Resolve the task's repo id to a sanitized `https://github.com/owner/repo` URL. */
  private async resolveRepository(auth: CloudAccountAuth, detail: RawCloudTaskDetail): Promise<string> {
    const repoId = typeof detail.repository === 'number' ? detail.repository : undefined;
    if (repoId === undefined) {
      return sanitizeRepositoryUrl(undefined);
    }
    const resolved = await this.deps.client.resolveRepo(auth, repoId);
    if (!resolved.ok) {
      return sanitizeRepositoryUrl(undefined);
    }
    return sanitizeRepositoryUrl(`https://github.com/${resolved.value.owner}/${resolved.value.name}`);
  }

  private record(outcome: PollOutcome): PollOutcome {
    this.lastOutcome = outcome;
    return outcome;
  }
}

/** Whether the per-account status set is unchanged (so the index need not be rewritten). */
function sameAccounts(prev: readonly CloudAccountStatus[], next: readonly CloudAccountStatus[]): boolean {
  if (prev.length !== next.length) {
    return false;
  }
  const key = (a: CloudAccountStatus): string => `${a.login} ${a.lastOutcome} ${a.lastErrorMessage ?? ''}`;
  const prevKeys = new Set(prev.map(key));
  return next.every((a) => prevKeys.has(key(a)));
}

/** Whether a task's summary entry meaningfully changed (state or session set). */
function entryChanged(prev: CloudTaskIndexEntry | undefined, next: CloudTaskIndexEntry): boolean {
  if (prev === undefined) {
    return true;
  }
  return (
    prev.state !== next.state ||
    prev.updatedAtMs !== next.updatedAtMs ||
    prev.sessionIds.length !== next.sessionIds.length ||
    prev.repository !== next.repository
  );
}
