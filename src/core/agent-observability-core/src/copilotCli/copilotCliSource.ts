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
import { parseCliEvents, readWorkspaceYaml } from './events';
import { isHelperRun } from './helperRuns';
import {
  buildCliAggregationRows,
  buildCliInteractions,
  buildCliSessionDetail,
  extractCliRetrospectiveSignals,
  resolveCliRepository,
  type CliSessionInput,
} from './mapper';
import {
  copilotHelperCwd,
  defaultCopilotCliFs,
  discoverCopilotCliSessions,
  type CopilotCliFs,
  type CopilotCliSessionFiles,
} from './paths';

/** Minimal config surface (satisfied by `Configuration`). */
export interface CopilotCliSourceConfig {
  isCopilotCliEnabled(): boolean;
  getExcludedRepositories(): ReadonlySet<string>;
}

interface Loaded {
  mtimeMs: number;
  size: number;
  input: CliSessionInput | undefined;
}

/**
 * GitHub Copilot CLI sessions (and sessions hosted through the Copilot SDK,
 * which writes the same store) as a {@link SessionDataSource}. Read-only.
 *
 * No context analysis: the events carry no "instruction file loaded" record,
 * so the Context tab is hidden for this source rather than guessed at.
 * `getAggregationRows` is complete for the contract's sake; the team shard's
 * outcome rows still exclude this source, because its `source` set is closed.
 */
export class CopilotCliSource implements SessionDataSource {
  readonly id: AgentSourceId = 'copilot-cli';
  readonly label = 'Copilot CLI';
  readonly costMode: CostMode = 'aiu';
  readonly iconId = 'terminal';

  private readonly git = new GitRemoteResolver();
  private readonly cache = new Map<string, Loaded>();
  private discovered: CopilotCliSessionFiles[] | undefined;

  constructor(
    private readonly config: CopilotCliSourceConfig,
    private readonly env: CopilotCliFs = defaultCopilotCliFs,
  ) {}

  isEnabled(): boolean {
    return this.config.isCopilotCliEnabled();
  }

  refresh(): void {
    this.discovered = undefined;
  }

  dispose(): void {
    this.cache.clear();
    this.discovered = undefined;
  }

  /** One session's parsed input, or `undefined` for a helper run or an unreadable file. */
  load(files: CopilotCliSessionFiles): CliSessionInput | undefined {
    const cached = this.cache.get(files.eventsFile);
    if (cached !== undefined && cached.mtimeMs === files.mtimeMs && cached.size === files.size) {
      return cached.input;
    }
    let input: CliSessionInput | undefined;
    try {
      const { events } = parseCliEvents(fs.readFileSync(files.eventsFile, 'utf8'));
      const workspace = readWorkspaceYaml(files.workspaceFile);
      const helper = isHelperRun(events, workspace, {
        helperCwd: copilotHelperCwd(this.env),
        homeDir: this.env.homedir(),
      });
      if (!helper && events.length > 0) {
        const repository = resolveCliRepository(workspace, events, (cwd) => this.git.resolve(cwd));
        input = { sessionId: files.sessionId, events, workspace, repository };
      }
    } catch {
      input = undefined;
    }
    this.cache.set(files.eventsFile, { mtimeMs: files.mtimeMs, size: files.size, input });
    return input;
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
      return { ok: false, reason: 'disabled', message: 'Copilot CLI is turned off in Settings.' };
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
      throw new Error('Copilot CLI session not found.');
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
