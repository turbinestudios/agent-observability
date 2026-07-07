/**
 * The **Copilot (Cloud)** `SessionDataSource`: reads the local sink (populated by
 * {@link CloudAgentPoller}) synchronously and maps it to the shared model shapes.
 *
 * The `SessionDataSource` contract is synchronous (`Result<T>`, not Promises), so
 * this is a pure materialize-then-read over the sink's raw files + versioned
 * index, cached by `index.json` mtime (the codebase idiom). It NEVER runs `gh` or
 * touches the network — the poller does. Repository exclusion is applied here (by
 * convention, like the Claude source). `getAggregationRows` returns `[]` — cloud
 * sessions are LOCAL-ONLY through Phases 1–3 (org upload is the deferred Phase 4,
 * gated on a source dimension + an ownership rule; see the plan §6).
 */

import type { FailureReason, Result } from '../telemetry/telemetryService';
import {
  AgentSourceId,
  CostMode,
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionDetail,
  SessionSummary,
} from '../telemetry/models';
import { UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';
import { AggregationRow } from '../aggregate/aggregator';
import { SessionDataSource } from '../sources/sessionSource';
import {
  CloudConfig,
  CloudSessionInput,
  CloudTaskIndexEntry,
  RawCloudSession,
  RawCloudTaskDetail,
} from './cloudTypes';
import { CloudSink } from './cloudSink';
import {
  buildCloudInteractions,
  buildCloudSessionDetail,
  buildCloudSessionSummary,
  buildCloudUserRequestContent,
} from './cloudMapper';
import { parseCloudSessionLog } from './sseParser';

const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

/** The agents-hub URL used as the Phase-1 external link fallback. */
const AGENTS_HUB_URL = 'https://github.com/copilot/agents';

interface CachedSummaries {
  mtimeMs: number;
  summaries: SessionSummary[];
}

export class CopilotCloudSource implements SessionDataSource {
  readonly id: AgentSourceId = 'copilot-cloud';
  readonly label = 'Copilot (Cloud)';
  readonly costMode: CostMode = 'credits';
  readonly iconId = 'cloud';

  private summaryCache: CachedSummaries | undefined;
  /** taskId → parsed raw detail, cached by index mtime. */
  private detailCache = new Map<string, RawCloudTaskDetail>();
  private detailCacheMtime = 0;

  constructor(
    private readonly config: CloudConfig,
    private readonly sink: CloudSink | undefined,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  isEnabled(): boolean {
    return this.config.isCopilotCloudEnabled();
  }

  refresh(): void {
    this.summaryCache = undefined;
    this.detailCache.clear();
    this.detailCacheMtime = 0;
  }

  dispose(): void {
    this.refresh();
  }

  /** A note when more tasks exist than the configured cap surfaced them. */
  truncationNote(): string | undefined {
    if (!this.isEnabled() || this.sink === undefined) {
      return undefined;
    }
    const index = this.sink.readIndex();
    if (!index.poller.firstPollCompleted && Object.keys(index.tasks).length === 0) {
      return 'First poll in progress — cloud sessions will appear shortly.';
    }
    return undefined;
  }

  getOverview(): Result<OverviewMetrics> {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled', message: 'Copilot (Cloud) capture is disabled.' };
    }
    if (this.sink === undefined) {
      return { ok: false, reason: 'error', message: 'No home directory available for the Copilot (Cloud) sink.' };
    }
    try {
      const summaries = this.loadSummaries();
      // Nothing to show → surface a poll failure (an OverviewMetrics object never
      // trips guard()'s array-empty check, so getOverview handles it explicitly).
      if (summaries.length === 0) {
        const failure = this.pollFailure();
        if (failure !== undefined) {
          return failure;
        }
      }
      const repositories = new Set<string>();
      const models = new Set<string>();
      let totalInteractions = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cachedTokens = 0;
      let durationSum = 0;
      for (const s of summaries) {
        totalInteractions += s.interactionCount;
        inputTokens += s.inputTokens;
        outputTokens += s.outputTokens;
        cachedTokens += s.cachedTokens;
        durationSum += s.durationMs;
        repositories.add(s.repository);
        if (isRealModel(s.model)) {
          models.add(s.model);
        }
      }
      const metrics: OverviewMetrics = {
        totalInteractions,
        totalSessions: summaries.length,
        totalRepositories: repositories.size,
        totalModels: models.size,
        avgDurationMs: summaries.length > 0 ? Math.round(durationSum / summaries.length) : 0,
        inputTokens,
        outputTokens,
        cachedTokens,
        errorCount: 0,
      };
      return { ok: true, value: metrics };
    } catch (err) {
      return { ok: false, reason: 'error', message: messageOf(err) };
    }
  }

  listRepositories(): Result<RepositorySummary[]> {
    return this.guard(() => {
      const byRepo = new Map<string, RepositorySummary>();
      for (const s of this.loadSummaries()) {
        const existing = byRepo.get(s.repository);
        if (existing === undefined) {
          byRepo.set(s.repository, {
            repository: s.repository,
            sessionCount: 1,
            interactionCount: s.interactionCount,
            models: isRealModel(s.model) ? [s.model] : [],
            lastActivityMs: s.endedAtMs,
          });
        } else {
          existing.sessionCount += 1;
          existing.interactionCount += s.interactionCount;
          if (isRealModel(s.model) && !existing.models.includes(s.model)) {
            existing.models.push(s.model);
          }
          existing.lastActivityMs = Math.max(existing.lastActivityMs, s.endedAtMs);
        }
      }
      return [...byRepo.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    });
  }

  listSessions(repository?: string, limit?: number): Result<SessionSummary[]> {
    return this.guard(() => {
      let summaries = this.loadSummaries();
      if (repository !== undefined) {
        summaries = summaries.filter((s) => s.repository === repository);
      }
      summaries = [...summaries].sort((a, b) => b.startedAtMs - a.startedAtMs);
      return limit !== undefined ? summaries.slice(0, limit) : summaries;
    });
  }

  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled', message: 'Copilot (Cloud) capture is disabled.' };
    }
    const input = this.inputFor(sessionKey);
    if (input === undefined) {
      return { ok: false, reason: 'error', message: `Copilot cloud session ${sessionKey} not found.` };
    }
    try {
      return { ok: true, value: buildCloudSessionDetail(input) };
    } catch (err) {
      return { ok: false, reason: 'error', message: messageOf(err) };
    }
  }

  getSessionInteractions(sessionKey: string): Result<Interaction[]> {
    return this.guard(() => {
      const input = this.inputFor(sessionKey);
      return input === undefined ? [] : buildCloudInteractions(input);
    });
  }

  getSessionContent(sessionKey: string, attribute: string): Result<ReadonlyMap<string, string>> {
    return this.guard(() => {
      if (attribute !== 'copilot_chat.user_request') {
        return new Map<string, string>();
      }
      const input = this.inputFor(sessionKey);
      return input === undefined ? new Map<string, string>() : buildCloudUserRequestContent(input);
    });
  }

  /**
   * Cloud sessions are LOCAL-ONLY through Phases 1–3 — nothing is uploaded. Org
   * aggregation is the deferred Phase 4 (needs a source dimension + an ownership
   * rule against double-counting org-visible sessions). `[]` is safe end-to-end
   * (the composite treats it as ok; buildBatch produces an empty heartbeat).
   */
  getAggregationRows(): Result<AggregationRow[]> {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled', message: 'Copilot (Cloud) capture is disabled.' };
    }
    return { ok: true, value: [] };
  }

  // ---- internals ----

  /** Wrap a producer: enabled check + surface poll failures when there is no data. */
  private guard<T>(fn: () => T): Result<T> {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled', message: 'Copilot (Cloud) capture is disabled.' };
    }
    if (this.sink === undefined) {
      return {
        ok: false,
        reason: 'error',
        message: 'No home directory available for the Copilot (Cloud) sink.',
      };
    }
    try {
      const value = fn();
      // Surface a poll failure only when there is nothing to show, so one account's
      // expired token never hides another account's healthy data.
      if (Array.isArray(value) && value.length === 0) {
        const failure = this.pollFailure();
        if (failure !== undefined) {
          return failure;
        }
      }
      return { ok: true, value };
    } catch (err) {
      return { ok: false, reason: 'error', message: messageOf(err) };
    }
  }

  /** The first failing account's taxonomy failure, or undefined when polling is healthy. */
  private pollFailure(): { ok: false; reason: FailureReason; message: string } | undefined {
    if (this.sink === undefined) {
      return undefined;
    }
    const { poller } = this.sink.readIndex();
    for (const account of poller.accounts) {
      if (account.lastOutcome !== 'ok') {
        return {
          ok: false,
          reason: normalizeReason(account.lastOutcome),
          message: account.lastErrorMessage ?? `${account.login}: ${account.lastOutcome}`,
        };
      }
    }
    return undefined;
  }

  private excluded(): ReadonlySet<string> {
    return this.config.getExcludedRepositories?.() ?? NO_EXCLUSIONS;
  }

  /** Build (and cache) every surfaced session summary, honoring repo exclusion. */
  private loadSummaries(): SessionSummary[] {
    if (this.sink === undefined) {
      return [];
    }
    const mtimeMs = this.sink.indexMtimeMs();
    if (this.summaryCache !== undefined && this.summaryCache.mtimeMs === mtimeMs) {
      return this.summaryCache.summaries;
    }
    const excluded = this.excluded();
    const out: SessionSummary[] = [];
    for (const entry of this.sink.listTaskEntries()) {
      if (excluded.has(entry.repository)) {
        continue;
      }
      const detail = this.taskDetail(entry.taskId, mtimeMs);
      if (detail === undefined) {
        continue;
      }
      const sessions = detail.sessions ?? [];
      for (let i = 0; i < sessions.length; i++) {
        const input = this.buildInput(entry, detail, sessions[i], sessions.length, i);
        out.push(buildCloudSessionSummary(input));
      }
    }
    this.summaryCache = { mtimeMs, summaries: out };
    return out;
  }

  /** Parse (and cache by index mtime) a task's raw detail payload. */
  private taskDetail(taskId: string, mtimeMs: number): RawCloudTaskDetail | undefined {
    if (this.sink === undefined) {
      return undefined;
    }
    if (this.detailCacheMtime !== mtimeMs) {
      this.detailCache.clear();
      this.detailCacheMtime = mtimeMs;
    }
    const cached = this.detailCache.get(taskId);
    if (cached !== undefined) {
      return cached;
    }
    const raw = this.sink.readTaskRaw(taskId);
    if (raw === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as RawCloudTaskDetail;
      this.detailCache.set(taskId, parsed);
      return parsed;
    } catch {
      return undefined;
    }
  }

  /** Assemble the mapper input for one session (parsing its log when present). */
  private buildInput(
    entry: CloudTaskIndexEntry,
    detail: RawCloudTaskDetail,
    session: RawCloudSession,
    sessionTotal: number,
    index: number,
  ): CloudSessionInput {
    const log =
      this.sink !== undefined && this.sink.hasSessionLog(session.id)
        ? parseCloudSessionLog(this.sink.readSessionLog(session.id) ?? '')
        : undefined;
    return {
      taskId: entry.taskId,
      taskName: typeof detail.name === 'string' ? detail.name : entry.taskId,
      taskState: entry.state,
      session,
      repository: entry.repository,
      log,
      nowMs: this.nowMs(),
      externalUrl: externalUrlFor(entry.repository, session),
      sessionLabelSuffix: sessionTotal > 1 ? ` — session ${index + 1}/${sessionTotal}` : undefined,
    };
  }

  /** Locate a session by key and build its mapper input, or undefined. */
  private inputFor(sessionKey: string): CloudSessionInput | undefined {
    if (this.sink === undefined) {
      return undefined;
    }
    const mtimeMs = this.sink.indexMtimeMs();
    for (const entry of this.sink.listTaskEntries()) {
      if (!entry.sessionIds.includes(sessionKey)) {
        continue;
      }
      const detail = this.taskDetail(entry.taskId, mtimeMs);
      const sessions = detail?.sessions ?? [];
      const index = sessions.findIndex((s) => s.id === sessionKey);
      if (detail === undefined || index < 0) {
        return undefined;
      }
      return this.buildInput(entry, detail, sessions[index], sessions.length, index);
    }
    return undefined;
  }
}

/** Build the "Open on GitHub" URL: the PR page when known, else the agents hub. */
function externalUrlFor(repository: string, session: RawCloudSession): string {
  if (
    repository !== UNKNOWN_REPOSITORY &&
    session.resource_type === 'pull_request' &&
    (typeof session.resource_id === 'number' || typeof session.resource_id === 'string')
  ) {
    return `${repository}/pull/${session.resource_id}`;
  }
  return AGENTS_HUB_URL;
}

/** A model id is "real" when it is neither empty nor the `unknown` sentinel. */
function isRealModel(model: string): boolean {
  return model.length > 0 && model !== 'unknown';
}

/** Coerce an account's `lastOutcome` string to a FailureReason for the view copy. */
function normalizeReason(outcome: string): FailureReason {
  const known: FailureReason[] = [
    'cliMissing',
    'unauthenticated',
    'featureUnavailable',
    'rateLimited',
    'network',
    'permission',
    'error',
  ];
  return (known as string[]).includes(outcome) ? (outcome as FailureReason) : 'error';
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
