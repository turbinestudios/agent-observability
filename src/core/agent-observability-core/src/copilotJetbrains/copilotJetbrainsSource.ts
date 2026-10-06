import * as fs from 'node:fs';
import type { AggregationRow } from '../aggregate/aggregator';
import { buildSessionRetrospective, type SessionRetrospective } from '../analysis/retrospective';
import { GitRemoteResolver } from '../claude/gitRemote';
import { defaultCopilotCliFs } from '../copilotCli/paths';
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
import {
  buildJetbrainsAggregationRows,
  buildJetbrainsInteractions,
  buildJetbrainsSessionDetail,
  jetbrainsSessionId,
  resolveJetbrainsRepository,
  type JetbrainsSessionInput,
} from './mapper';
import { scanNitriteStore, type JetbrainsScanStats } from './nitriteScan';
import { discoverJetbrainsStores, type JetbrainsFs, type JetbrainsStoreFile } from './paths';

/** Minimal config surface (satisfied by `Configuration`). */
export interface CopilotJetbrainsSourceConfig {
  isCopilotJetbrainsEnabled(): boolean;
  getCopilotJetbrainsStorePath(): string | undefined;
  getExcludedRepositories(): ReadonlySet<string>;
}

/** What one store yielded, for Settings and the index notes. */
export interface JetbrainsStoreResult {
  store: JetbrainsStoreFile;
  sessions: JetbrainsSessionInput[];
  /** Set when the file could not be read, or held nothing the scanner recognised. */
  problem?: 'locked' | 'unrecognised';
  stats?: JetbrainsScanStats;
}

interface Loaded {
  mtimeMs: number;
  size: number;
  result: JetbrainsStoreResult;
}

/**
 * Copilot chats from JetBrains IDEs (Rider, IntelliJ IDEA, …) as a
 * {@link SessionDataSource}. Read-only: each store file is read whole into
 * memory and scanned (see {@link scanNitriteStore}); nothing is opened for
 * writing and no lock is taken.
 *
 * Billed in Copilot units like the other Copilot sources, but the plugin
 * records no usage, so its sessions carry no cost. No context analysis, no
 * tool calls and no activity: the store holds none of them in a form the
 * scanner can read.
 */
export class CopilotJetbrainsSource implements SessionDataSource {
  readonly id: AgentSourceId = 'copilot-jetbrains';
  readonly label = 'Copilot (JetBrains)';
  readonly costMode: CostMode = 'aiu';
  readonly iconId = 'symbol-class';

  private readonly git = new GitRemoteResolver();
  private readonly cache = new Map<string, Loaded>();
  private discovered: JetbrainsStoreFile[] | undefined;

  constructor(
    private readonly config: CopilotJetbrainsSourceConfig,
    private readonly env: JetbrainsFs = defaultCopilotCliFs,
    private readonly readFile: (file: string) => Uint8Array = (file) => fs.readFileSync(file),
    private readonly now: () => number = () => Date.now(),
  ) {}

  isEnabled(): boolean {
    return this.config.isCopilotJetbrainsEnabled();
  }

  refresh(): void {
    this.discovered = undefined;
  }

  dispose(): void {
    this.cache.clear();
    this.discovered = undefined;
  }

  stores(): JetbrainsStoreFile[] {
    this.discovered ??= discoverJetbrainsStores(this.config.getCopilotJetbrainsStorePath(), this.env);
    return this.discovered;
  }

  /** One store's sessions, re-scanned only when the file's size or mtime moved. */
  load(store: JetbrainsStoreFile): JetbrainsStoreResult {
    const cached = this.cache.get(store.path);
    if (cached !== undefined && cached.mtimeMs === store.mtimeMs && cached.size === store.size) {
      return cached.result;
    }
    let result: JetbrainsStoreResult;
    let bytes: Uint8Array | undefined;
    try {
      bytes = this.readFile(store.path);
    } catch {
      bytes = undefined;
    }
    if (bytes === undefined) {
      result = { store, sessions: [], problem: 'locked' };
    } else {
      const scan = scanNitriteStore(bytes, this.now());
      const sessions = scan.conversations.map((conversation, index) => ({
        sessionId: jetbrainsSessionId(store, conversation, index),
        store,
        conversation,
        repository: resolveJetbrainsRepository(conversation, (dir) => this.git.resolve(dir)),
        ...(scan.defaultModel !== undefined ? { defaultModel: scan.defaultModel } : {}),
      }));
      result = { store, sessions, stats: scan.stats, ...(sessions.length === 0 ? { problem: 'unrecognised' as const } : {}) };
    }
    this.cache.set(store.path, { mtimeMs: store.mtimeMs, size: store.size, result });
    return result;
  }

  private sessions(): JetbrainsSessionInput[] {
    const excluded = this.config.getExcludedRepositories();
    const seen = new Set<string>();
    const out: JetbrainsSessionInput[] = [];
    for (const store of this.stores()) {
      for (const input of this.load(store).sessions) {
        // The same conversation can sit in more than one store; the newest store wins.
        if (!seen.has(input.sessionId) && !excluded.has(input.repository)) {
          seen.add(input.sessionId);
          out.push(input);
        }
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

  private find(sessionKey: string): JetbrainsSessionInput {
    const input = this.sessions().find((s) => s.sessionId === sessionKey);
    if (input === undefined) {
      throw new Error(`${this.label} session not found.`);
    }
    return input;
  }

  listSessions(repository?: string, limit?: number): Result<SessionSummary[]> {
    return this.guard(() => {
      const all = this.sessions()
        .map((s) => buildJetbrainsSessionDetail(s).summary)
        .filter((s) => repository === undefined || s.repository === repository);
      return limit === undefined ? all : all.slice(0, limit);
    });
  }

  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    return this.guard(() => buildJetbrainsSessionDetail(this.find(sessionKey)));
  }

  getSessionInteractions(sessionKey: string): Result<Interaction[]> {
    return this.guard(() => buildJetbrainsInteractions(this.find(sessionKey)));
  }

  getAggregationRows(sinceMs?: number, untilMs?: number): Result<AggregationRow[]> {
    return this.guard(() => this.sessions().flatMap((s) => buildJetbrainsAggregationRows(s, sinceMs, untilMs)));
  }

  getSessionRetrospective(sessionKey: string, detail?: SessionDetail): Result<SessionRetrospective> {
    return this.guard(() => buildSessionRetrospective(detail ?? buildJetbrainsSessionDetail(this.find(sessionKey))));
  }

  listRepositories(): Result<RepositorySummary[]> {
    return this.guard(() => {
      const byRepo = new Map<string, RepositorySummary & { modelSet: Set<string> }>();
      for (const input of this.sessions()) {
        const s = buildJetbrainsSessionDetail(input).summary;
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
        .map((s) => buildJetbrainsSessionDetail(s))
        .filter((d) => sinceMs === undefined || d.summary.endedAtMs >= sinceMs);
      const interactions = details.reduce((n, d) => n + d.summary.interactionCount, 0);
      return {
        totalInteractions: interactions,
        totalSessions: details.length,
        totalRepositories: new Set(details.map((d) => d.summary.repository)).size,
        totalModels: new Set(details.map((d) => d.summary.model)).size,
        avgDurationMs: details.length === 0 ? 0 : details.reduce((n, d) => n + d.summary.durationMs, 0) / details.length,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        errorCount: details.reduce((n, d) => n + d.treeStats.errorCount, 0),
      };
    });
  }
}
