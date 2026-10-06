import * as fs from 'node:fs';
import type { AggregationRow } from '../aggregate/aggregator';
import { buildSessionRetrospective, type SessionRetrospective } from '../analysis/retrospective';
import { GitRemoteResolver } from '../claude/gitRemote';
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
import type { Result } from '../telemetry/telemetryService';
import { cliClientOf, parseCliEvents, readWorkspaceYaml, type CliClient } from './events';
import { isHelperRun } from './helperRuns';
import {
  buildCliAggregationRows,
  buildCliInteractions,
  buildCliSessionDetail,
  extractCliRetrospectiveSignals,
  resolveCliRepository,
  summarizeCliUsage,
  type CliSessionInput,
  type CliSourceId,
} from './mapper';
import { SessionStoreUsageCache, sessionStorePath } from './sessionStoreUsage';
import {
  copilotHelperCwd,
  copilotHome,
  defaultCopilotCliFs,
  discoverCopilotCliSessions,
  type CopilotCliFs,
  type CopilotCliSessionFiles,
} from './paths';

/** Minimal config surface (satisfied by `Configuration`). */
export interface CopilotCliSourceConfig {
  isCopilotCliEnabled(): boolean;
  isCopilotAppEnabled?(): boolean;
  getExcludedRepositories(): ReadonlySet<string>;
}

interface Loaded {
  mtimeMs: number;
  size: number;
  input: CliSessionInput | undefined;
}

interface ClientProfile {
  id: CliSourceId;
  label: string;
  iconId: string;
}

const PROFILES: Record<CliClient, ClientProfile> = {
  cli: { id: 'copilot-cli', label: 'Copilot CLI', iconId: 'terminal' },
  app: { id: 'copilot-app', label: 'Copilot app', iconId: 'device-desktop' },
};

/**
 * GitHub Copilot CLI sessions (and sessions hosted through the Copilot SDK,
 * which writes the same store) as a {@link SessionDataSource}. Read-only.
 *
 * The GitHub Copilot app writes the same store through the same runtime, so
 * one class serves both: constructed for `client: 'app'` it lists only the
 * app's sessions (`client_name: github/autopilot`) as "Copilot app", and the
 * default CLI instance lists everything else.
 *
 * No context analysis: the events carry no "instruction file loaded" record,
 * so the Context tab is hidden for this source rather than guessed at.
 */
export class CopilotCliSource implements SessionDataSource {
  readonly id: AgentSourceId;
  readonly label: string;
  readonly costMode: CostMode = 'aiu';
  readonly iconId: string;

  private readonly git = new GitRemoteResolver();
  private readonly cache = new Map<string, Loaded>();
  private readonly storeUsage: SessionStoreUsageCache;
  private discovered: CopilotCliSessionFiles[] | undefined;

  constructor(
    private readonly config: CopilotCliSourceConfig,
    private readonly env: CopilotCliFs = defaultCopilotCliFs,
    readonly client: CliClient = 'cli',
  ) {
    const profile = PROFILES[client];
    this.id = profile.id;
    this.label = profile.label;
    this.iconId = profile.iconId;
    this.storeUsage = new SessionStoreUsageCache(() => sessionStorePath(copilotHome(this.env)));
  }

  isEnabled(): boolean {
    return this.client === 'app'
      ? this.config.isCopilotAppEnabled?.() ?? true
      : this.config.isCopilotCliEnabled();
  }

  refresh(): void {
    this.discovered = undefined;
  }

  dispose(): void {
    this.cache.clear();
    this.discovered = undefined;
  }

  /** Whether a session directory belongs to this instance's client. Reads only `workspace.yaml`. */
  owns(files: CopilotCliSessionFiles): boolean {
    return cliClientOf(readWorkspaceYaml(files.workspaceFile)) === this.client;
  }

  /**
   * One session's parsed input, or `undefined` for a helper run, an
   * unreadable file, or a session another client wrote.
   */
  load(files: CopilotCliSessionFiles): CliSessionInput | undefined {
    const cached = this.cache.get(files.eventsFile);
    if (cached !== undefined && cached.mtimeMs === files.mtimeMs && cached.size === files.size) {
      return cached.input === undefined ? undefined : this.withStoreUsage(cached.input);
    }
    let input: CliSessionInput | undefined;
    try {
      const workspace = readWorkspaceYaml(files.workspaceFile);
      if (cliClientOf(workspace) === this.client) {
        const { events } = parseCliEvents(fs.readFileSync(files.eventsFile, 'utf8'));
        const helper = isHelperRun(events, workspace, {
          helperCwd: copilotHelperCwd(this.env),
          homeDir: this.env.homedir(),
        });
        if (!helper && events.length > 0) {
          const repository = resolveCliRepository(workspace, events, (cwd) => this.git.resolve(cwd));
          input = { sessionId: files.sessionId, events, workspace, repository, source: this.id as CliSourceId };
        }
      }
    } catch {
      input = undefined;
    }
    this.cache.set(files.eventsFile, { mtimeMs: files.mtimeMs, size: files.size, input });
    return input === undefined ? undefined : this.withStoreUsage(input);
  }

  /**
   * Attaches the runtime store's usage when the events have no token totals.
   * The store is opened only then, and re-read only when it changed.
   */
  private withStoreUsage(input: CliSessionInput): CliSessionInput {
    const fromEvents = summarizeCliUsage(input.events);
    if (fromEvents.inputTokens + fromEvents.cachedTokens > 0) {
      return input;
    }
    const storeUsage = this.storeUsage.get().get(input.sessionId);
    return storeUsage === undefined ? input : { ...input, storeUsage };
  }

  private sessions(): CliSessionInput[] {
    this.discovered ??= discoverCopilotCliSessions(this.env);
    const excluded = this.config.getExcludedRepositories();
    const out: CliSessionInput[] = [];
    for (const files of this.discovered) {
      const input = this.load(files);
      if (input !== undefined && !excluded.has(input.repository)) {
        out.push(input);
      }
    }
    return out;
  }

  private guard<T>(work: () => T): Result<T> {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled', message: `${this.label} is turned off in Settings.` };
    }
    try {
      return { ok: true, value: work() };
    } catch (err) {
      return { ok: false, reason: 'unreadable', message: err instanceof Error ? err.message : String(err) };
    }
  }

  private find(sessionKey: string): CliSessionInput {
    const input = this.sessions().find((s) => s.sessionId === sessionKey);
    if (input === undefined) {
      throw new Error(`${this.label} session not found.`);
    }
    return input;
  }

  listSessions(repository?: string, limit?: number): Result<SessionSummary[]> {
    return this.guard(() => {
      const all = this.sessions()
        .map((s) => buildCliSessionDetail(s).summary)
        .filter((s) => repository === undefined || s.repository === repository);
      return limit === undefined ? all : all.slice(0, limit);
    });
  }

  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    return this.guard(() => buildCliSessionDetail(this.find(sessionKey)));
  }

  getSessionInteractions(sessionKey: string): Result<Interaction[]> {
    return this.guard(() => buildCliInteractions(this.find(sessionKey)));
  }

  getAggregationRows(sinceMs?: number, untilMs?: number): Result<AggregationRow[]> {
    return this.guard(() => this.sessions().flatMap((s) => buildCliAggregationRows(s, sinceMs, untilMs)));
  }

  getSessionRetrospective(sessionKey: string, detail?: SessionDetail): Result<SessionRetrospective> {
    return this.guard(() => {
      const input = this.find(sessionKey);
      return buildSessionRetrospective(detail ?? buildCliSessionDetail(input), extractCliRetrospectiveSignals(input.events));
    });
  }

  listRepositories(): Result<RepositorySummary[]> {
    return this.guard(() => {
      const byRepo = new Map<string, RepositorySummary & { modelSet: Set<string> }>();
      for (const input of this.sessions()) {
        const s = buildCliSessionDetail(input).summary;
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
        .map((s) => buildCliSessionDetail(s))
        .filter((d) => sinceMs === undefined || d.summary.endedAtMs >= sinceMs);
      const total = (pick: (d: SessionDetail) => number): number => details.reduce((n, d) => n + pick(d), 0);
      const interactions = total((d) => d.summary.interactionCount);
      return {
        totalInteractions: interactions,
        totalSessions: details.length,
        totalRepositories: new Set(details.map((d) => d.summary.repository)).size,
        totalModels: new Set(details.map((d) => d.summary.model)).size,
        avgDurationMs: details.length === 0 ? 0 : total((d) => d.summary.durationMs) / details.length,
        inputTokens: total((d) => d.summary.inputTokens),
        outputTokens: total((d) => d.summary.outputTokens),
        cachedTokens: total((d) => d.summary.cachedTokens),
        errorCount: total((d) => d.treeStats.errorCount),
      };
    });
  }
}
