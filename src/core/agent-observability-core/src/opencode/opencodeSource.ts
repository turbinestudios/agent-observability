import type { AggregationRow } from '../aggregate/aggregator';
import { buildSessionRetrospective, type SessionRetrospective } from '../analysis/retrospective';
import { GitRemoteResolver } from '../claude/gitRemote';
import { defaultCopilotCliFs, type CopilotCliFs } from '../copilotCli/paths';
import type { AcceptedMissingConfig } from '../context/contextAnalyzer';
import type { SessionContextAnalysis } from '../context/models';
import type { SessionDataSource } from '../sources/sessionSource';
import type {
  AgentSourceId,
  CostMode,
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionDetail,
  SessionSummary,
} from '../telemetry/models';
import type { SnapshotOptions } from '../telemetry/snapshot';
import type { Result } from '../telemetry/telemetryService';
import {
  buildOpencodeAggregationRows,
  buildOpencodeInteractions,
  buildOpencodeSessionDetail,
  groupOpencodeSessions,
  type OpencodeSessionInput,
} from './mapper';
import { analyzeOpencodeContext } from './contextAnalysis';
import { opencodeDbPath } from './paths';
import { OpencodeStoreCache, type OpencodeStore } from './store';

/** Minimal config surface (satisfied by `Configuration`). */
export interface OpencodeSourceConfig {
  isOpencodeEnabled(): boolean;
  getOpencodeDbPath(): string | undefined;
  getExcludedRepositories(): ReadonlySet<string>;
}

/**
 * OpenCode sessions as a {@link SessionDataSource}, whichever provider served
 * them: GitHub Copilot (signed in through OpenCode's own `/connect`), OpenAI,
 * Anthropic and the rest. Read-only, through a snapshot copy of
 * `opencode.db` that is re-taken only when the file moves.
 *
 * Priced in USD from the cost OpenCode records; Copilot-served turns are
 * priced in AI credits from their tokens (see `./mapper.ts`). Context
 * analysis comes from OpenCode's own record of the instruction files and
 * skills it loaded (see `./contextAnalysis.ts`).
 */
export class OpencodeSource implements SessionDataSource {
  readonly id: AgentSourceId = 'opencode';
  readonly label = 'OpenCode';
  readonly costMode: CostMode = 'usd';
  readonly iconId = 'terminal';

  private readonly git = new GitRemoteResolver();
  private readonly store: OpencodeStoreCache;
  private grouped: { from: OpencodeStore; sessions: OpencodeSessionInput[] } | undefined;

  constructor(
    private readonly config: OpencodeSourceConfig,
    private readonly env: CopilotCliFs = defaultCopilotCliFs,
    snapshot: SnapshotOptions = {},
  ) {
    this.store = new OpencodeStoreCache(() => this.dbPath(), snapshot);
  }

  isEnabled(): boolean {
    return this.config.isOpencodeEnabled();
  }

  dbPath(): string {
    return opencodeDbPath(this.config.getOpencodeDbPath(), this.env);
  }

  /** Size and mtime of the database plus its `-wal`; `undefined` when there is none. */
  stamp(): { size: number; mtimeMs: number } | undefined {
    return this.store.stamp();
  }

  refresh(): void {
    this.store.clear();
    this.grouped = undefined;
  }

  dispose(): void {
    this.refresh();
  }

  /** Every root session, excluded repositories left out, newest first. Throws when the store cannot be read. */
  sessions(): OpencodeSessionInput[] {
    const store = this.store.get();
    if (this.grouped?.from !== store) {
      this.grouped = { from: store, sessions: groupOpencodeSessions(store, (dir) => this.git.resolve(dir)) };
    }
    const excluded = this.config.getExcludedRepositories();
    return this.grouped.sessions.filter((s) => !excluded.has(s.repository));
  }

  private guard<T>(work: () => T): Result<T> {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled', message: `${this.label} is turned off in Settings.` };
    }
    if (this.stamp() === undefined) {
      return { ok: false, reason: 'missingDb', message: `No ${this.label} database at ${this.dbPath()}.` };
    }
    try {
      return { ok: true, value: work() };
    } catch (err) {
      return { ok: false, reason: 'unreadable', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private find(sessionKey: string): OpencodeSessionInput {
    const input = this.sessions().find((s) => s.session.id === sessionKey);
    if (input === undefined) {
      throw new Error(`${this.label} session not found.`);
    }
    return input;
  }

  listSessions(repository?: string, limit?: number): Result<SessionSummary[]> {
    return this.guard(() => {
      const all = this.sessions()
        .filter((s) => repository === undefined || s.repository === repository)
        .map((s) => buildOpencodeSessionDetail(s).summary);
      return limit === undefined ? all : all.slice(0, limit);
    });
  }

  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    return this.guard(() => buildOpencodeSessionDetail(this.find(sessionKey)));
  }

  getSessionInteractions(sessionKey: string): Result<Interaction[]> {
    return this.guard(() => buildOpencodeInteractions(this.find(sessionKey)));
  }

  getAggregationRows(sinceMs?: number, untilMs?: number): Result<AggregationRow[]> {
    return this.guard(() => this.sessions().flatMap((s) => buildOpencodeAggregationRows(s, sinceMs, untilMs)));
  }

  getSessionRetrospective(sessionKey: string, detail?: SessionDetail): Result<SessionRetrospective> {
    return this.guard(() => buildSessionRetrospective(detail ?? buildOpencodeSessionDetail(this.find(sessionKey))));
  }

  getContextAnalysis(sessionKey: string, acceptedMissing: AcceptedMissingConfig): SessionContextAnalysis | undefined {
    if (!this.isEnabled()) {
      return undefined;
    }
    try {
      const input = this.sessions().find((s) => s.session.id === sessionKey);
      return input === undefined ? undefined : analyzeOpencodeContext(input, acceptedMissing, this.env);
    } catch {
      return undefined;
    }
  }

  listRepositories(): Result<RepositorySummary[]> {
    return this.guard(() => {
      const byRepo = new Map<string, RepositorySummary & { modelSet: Set<string> }>();
      for (const input of this.sessions()) {
        const s = buildOpencodeSessionDetail(input).summary;
        const entry =
          byRepo.get(s.repository) ??
          { repository: s.repository, sessionCount: 0, interactionCount: 0, models: [], lastActivityMs: 0, modelSet: new Set<string>() };
        entry.sessionCount += 1;
        entry.interactionCount += s.interactionCount;
        entry.lastActivityMs = Math.max(entry.lastActivityMs, s.endedAtMs);
        entry.modelSet.add(s.model);
        byRepo.set(s.repository, entry);
      }
      return [...byRepo.values()].map(({ modelSet, ...rest }) => ({ ...rest, models: [...modelSet].sort() }));
    });
  }

  getOverview(sinceMs?: number): Result<OverviewMetrics> {
    return this.guard(() => {
      const details = this.sessions()
        .map((s) => buildOpencodeSessionDetail(s))
        .filter((d) => sinceMs === undefined || d.summary.endedAtMs >= sinceMs);
      return {
        totalInteractions: details.reduce((n, d) => n + d.summary.interactionCount, 0),
        totalSessions: details.length,
        totalRepositories: new Set(details.map((d) => d.summary.repository)).size,
        totalModels: new Set(details.map((d) => d.summary.model)).size,
        avgDurationMs: details.length === 0 ? 0 : details.reduce((n, d) => n + d.summary.durationMs, 0) / details.length,
        inputTokens: details.reduce((n, d) => n + d.treeStats.inputTokens, 0),
        outputTokens: details.reduce((n, d) => n + d.treeStats.outputTokens, 0),
        cachedTokens: details.reduce((n, d) => n + d.treeStats.cachedTokens, 0),
        errorCount: details.reduce((n, d) => n + d.treeStats.errorCount, 0),
      };
    });
  }
}
