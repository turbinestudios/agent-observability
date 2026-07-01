import * as fs from 'node:fs';
import type { Result } from '../telemetry/telemetryService';
import { AggregationRow } from '../aggregate/aggregator';
import {
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionDetail,
  SessionSummary,
} from '../telemetry/models';
import { UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';
import { SessionDataSource } from '../sources/sessionSource';
import type { SessionContextAnalysis } from '../context/models';
import type { AcceptedMissingConfig } from '../context/contextAnalyzer';
import { analyzeClaudeContext } from './claudeContextAnalyzer';
import {
  ClaudeFs,
  ClaudePathConfig,
  ClaudeSessionFiles,
  discoverClaudeSessions,
} from './paths';
import { ParseResult, readTranscriptFile } from './parser';
import { GitRemoteResolver } from './gitRemote';
import { TranscriptRecord, contentBlocks } from './transcript';
import {
  ClaudeSessionInput,
  ClaudeSubagentTranscript,
  buildAggregationRows,
  buildInteractions,
  buildSessionDetail,
  buildSessionSummary,
  buildUserRequestContent,
} from './mapper';

/**
 * {@link SessionDataSource} over Claude Code's JSONL transcripts.
 *
 * Discovers sessions under `~/.claude/projects` ({@link discoverClaudeSessions}),
 * parses them on demand into the shared model shapes ({@link ./mapper}), and
 * memoizes per-file parses + per-session summaries keyed by file mtime so a
 * refresh only re-reads what changed.
 *
 * Performance: a developer can accumulate thousands of transcripts. To keep the
 * synchronous tree responsive, the Sessions list is bounded to the
 * `claudeCode.maxSessions` most-recently-active sessions (full token/cost detail
 * is computed lazily and cached). The bound is surfaced, never silent: the
 * count of sessions beyond the cap is reported via {@link getTruncation}.
 *
 * Privacy: raw transcript content is read only for the local detail view (the
 * mapper HTML-escapes it downstream) and never reaches the aggregation rows.
 */

/** Config surface the service reads (satisfied by `Configuration`). */
export interface ClaudeServiceConfig extends ClaudePathConfig {
  isClaudeEnabled(): boolean;
  getCodeFileExtensions(): string[];
  getDocFileExtensions(): string[];
  /** Max most-recent sessions to surface in the list / aggregate by default. */
  getClaudeMaxSessions(): number;
}

/** A parsed file held with the mtime it was parsed at (cache key). */
interface ParsedFile {
  mtimeMs: number;
  result: ParseResult;
}

/** A memoized session summary held with its newest-file mtime. */
interface CachedSummary {
  mtimeMs: number;
  summary: SessionSummary;
}

export class ClaudeCodeService implements SessionDataSource {
  readonly id = 'claude' as const;
  readonly label = 'Claude Code';

  private discovered: ClaudeSessionFiles[] | undefined;
  private readonly fileCache = new Map<string, ParsedFile>();
  private readonly summaryCache = new Map<string, CachedSummary>();
  private gitResolver = new GitRemoteResolver();
  /** Sessions discovered beyond the surfaced cap (for the truncation notice). */
  private truncatedCount = 0;

  constructor(
    private readonly config: ClaudeServiceConfig,
    private readonly env?: ClaudeFs,
  ) {}

  isEnabled(): boolean {
    return this.config.isClaudeEnabled();
  }

  refresh(): void {
    this.discovered = undefined;
    this.fileCache.clear();
    this.summaryCache.clear();
    this.gitResolver = new GitRemoteResolver();
    this.truncatedCount = 0;
  }

  /**
   * Cheap invalidation for the live watcher: forget only the directory listing
   * so the next query re-walks to pick up new/removed session files, while the
   * mtime-keyed parse + summary caches survive. Because those caches are keyed by
   * file mtime, an appended-to transcript misses the cache and re-parses, but
   * every untouched session is reused — so a transcript event during an active
   * session costs one re-parse, not a full re-scan of the most-recent N sessions.
   */
  invalidateDiscovery(): void {
    this.discovered = undefined;
  }

  dispose(): void {
    this.refresh();
  }

  /** Number of sessions NOT surfaced because of the most-recent cap (0 = none). */
  getTruncation(): number {
    return this.truncatedCount;
  }

  /** Notice when the most-recent cap hid older sessions, else `undefined`. */
  truncationNote(): string | undefined {
    if (this.truncatedCount <= 0) {
      return undefined;
    }
    return `Showing the ${this.maxSessions()} most recent Claude Code sessions; ${this.truncatedCount} older session${this.truncatedCount === 1 ? '' : 's'} hidden. Raise "agentObservability.claudeCode.maxSessions" to show more.`;
  }

  getOverview(): Result<OverviewMetrics> {
    return this.guard(() => {
      const summaries = this.listSummaries();
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
      const overview: OverviewMetrics = {
        totalInteractions,
        totalSessions: summaries.length,
        totalRepositories: repositories.size,
        totalModels: models.size,
        // Mean session duration (Claude has no per-span latency); 0 when empty.
        avgDurationMs: summaries.length > 0 ? Math.round(durationSum / summaries.length) : 0,
        inputTokens,
        outputTokens,
        cachedTokens,
        errorCount: 0,
      };
      return overview;
    });
  }

  listRepositories(): Result<RepositorySummary[]> {
    return this.guard(() => {
      const merged = new Map<string, RepositorySummary>();
      for (const s of this.listSummaries()) {
        const acc = merged.get(s.repository);
        if (acc === undefined) {
          merged.set(s.repository, {
            repository: s.repository,
            sessionCount: 1,
            interactionCount: s.interactionCount,
            models: isRealModel(s.model) ? [s.model] : [],
            // lastActivityMs = latest activity (session END), matching the Copilot adapter.
            lastActivityMs: s.endedAtMs,
          });
        } else {
          acc.sessionCount += 1;
          acc.interactionCount += s.interactionCount;
          if (isRealModel(s.model) && !acc.models.includes(s.model)) {
            acc.models = [...acc.models, s.model].sort();
          }
          acc.lastActivityMs = Math.max(acc.lastActivityMs, s.endedAtMs);
        }
      }
      return [...merged.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    });
  }

  listSessions(repository?: string, limit?: number): Result<SessionSummary[]> {
    return this.guard(() => {
      let summaries = this.listSummaries();
      if (repository !== undefined) {
        summaries = summaries.filter((s) => s.repository === repository);
      }
      const sorted = [...summaries].sort((a, b) => b.startedAtMs - a.startedAtMs);
      return limit !== undefined ? sorted.slice(0, limit) : sorted;
    });
  }

  getSessionInteractions(sessionKey: string): Result<Interaction[]> {
    return this.guard(() => {
      const input = this.loadSessionInput(sessionKey, false);
      if (input === undefined) {
        return [];
      }
      return buildInteractions(input);
    });
  }

  getSessionContent(sessionKey: string, attribute: string): Result<ReadonlyMap<string, string>> {
    return this.guard(() => {
      // Only the user's prompt is reconstructable from a Claude transcript; every
      // other content attribute (tool args, system prompt, …) is Copilot-specific
      // with no Claude equivalent, so it stays empty and the predicate is inert.
      if (attribute !== 'copilot_chat.user_request') {
        return new Map<string, string>();
      }
      const input = this.loadSessionInput(sessionKey, false);
      if (input === undefined) {
        return new Map<string, string>();
      }
      return buildUserRequestContent(input);
    });
  }

  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    const input = this.config.isClaudeEnabled() ? this.loadSessionInput(sessionKey, true) : undefined;
    if (!this.config.isClaudeEnabled()) {
      return { ok: false, reason: 'disabled', message: 'Claude Code capture is disabled.' };
    }
    if (input === undefined) {
      return { ok: false, reason: 'error', message: `Claude Code session ${sessionKey} not found.` };
    }
    try {
      return { ok: true, value: buildSessionDetail(input) };
    } catch (err) {
      return { ok: false, reason: 'error', message: messageOf(err) };
    }
  }

  /**
   * LOCAL-ONLY context-window analysis for a Claude session. Reconstructs the
   * loaded-context set from the transcript plus the on-disk CLAUDE.md / `.claude`
   * tree (see {@link analyzeClaudeContext}). Returns `undefined` when capture is
   * disabled, the session is missing, or there is no context signal — the panel
   * hides the tab in that case. Never throws into the view.
   */
  getContextAnalysis(
    sessionKey: string,
    acceptedMissing: AcceptedMissingConfig,
  ): SessionContextAnalysis | undefined {
    if (!this.config.isClaudeEnabled()) {
      return undefined;
    }
    try {
      const input = this.loadSessionInput(sessionKey, true);
      if (input === undefined) {
        return undefined;
      }
      return analyzeClaudeContext(input, acceptedMissing, this.env);
    } catch {
      return undefined;
    }
  }

  getAggregationRows(sinceMs?: number, untilMs?: number): Result<AggregationRow[]> {
    return this.guard(() => {
      const sessions = this.ensureDiscovered();
      const cap = this.maxSessions();
      const rows: AggregationRow[] = [];
      let count = 0;
      for (const session of sessions) {
        // mtime ~ last activity: skip sessions clearly outside the window.
        if (sinceMs !== undefined && session.mtimeMs > 0 && session.mtimeMs < sinceMs) {
          continue;
        }
        if (count >= cap) {
          break;
        }
        count += 1;
        const input = this.buildInput(session, true);
        if (input === undefined) {
          continue;
        }
        for (const row of buildAggregationRows(input)) {
          if (sinceMs !== undefined && row.startTimeMs < sinceMs) {
            continue;
          }
          if (untilMs !== undefined && row.startTimeMs >= untilMs) {
            continue;
          }
          rows.push(row);
        }
      }
      return rows;
    });
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Run `fn` behind the enable gate, mapping a throw to a typed failure. */
  private guard<T>(fn: () => T): Result<T> {
    if (!this.config.isClaudeEnabled()) {
      return { ok: false, reason: 'disabled', message: 'Claude Code capture is disabled.' };
    }
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      return { ok: false, reason: 'error', message: messageOf(err) };
    }
  }

  /** Build summaries for the most-recent (capped) sessions, memoized by mtime. */
  private listSummaries(): SessionSummary[] {
    const sessions = this.ensureDiscovered();
    const cap = this.maxSessions();
    this.truncatedCount = Math.max(0, sessions.length - cap);
    const out: SessionSummary[] = [];
    for (const session of sessions.slice(0, cap)) {
      const summary = this.summaryFor(session);
      if (summary !== undefined) {
        out.push(summary);
      }
    }
    return out;
  }

  private summaryFor(session: ClaudeSessionFiles): SessionSummary | undefined {
    const cached = this.summaryCache.get(session.sessionId);
    if (cached !== undefined && cached.mtimeMs === session.mtimeMs) {
      return cached.summary;
    }
    // Summary needs the main thread only; sub-agents are not parsed here.
    const input = this.buildInput(session, false);
    if (input === undefined) {
      return undefined;
    }
    const summary = buildSessionSummary(input);
    this.summaryCache.set(session.sessionId, { mtimeMs: session.mtimeMs, summary });
    return summary;
  }

  private loadSessionInput(sessionKey: string, withSubagents: boolean): ClaudeSessionInput | undefined {
    const session = this.ensureDiscovered().find((s) => s.sessionId === sessionKey);
    if (session === undefined) {
      return undefined;
    }
    return this.buildInput(session, withSubagents);
  }

  /** Parse a session's files (cached) into mapper input; `undefined` if empty. */
  private buildInput(
    session: ClaudeSessionFiles,
    withSubagents: boolean,
  ): ClaudeSessionInput | undefined {
    const mainRecords = session.mainFile !== undefined ? this.parseFile(session.mainFile) : [];
    const subagents: ClaudeSubagentTranscript[] = [];
    if (withSubagents && session.subagentFiles.length > 0) {
      const agentTypeById = buildAgentTypeIndex(mainRecords);
      for (const file of session.subagentFiles) {
        const records = this.parseFile(file);
        if (records.length === 0) {
          continue;
        }
        subagents.push({ agentType: resolveAgentType(records, agentTypeById), records });
      }
    }
    if (mainRecords.length === 0 && subagents.length === 0) {
      return undefined;
    }
    const cwd = firstCwd(mainRecords) ?? firstCwd(subagents.flatMap((s) => s.records));
    return {
      sessionId: session.sessionId,
      mainRecords,
      subagents,
      repository: this.gitResolver.resolve(cwd),
      cwd,
      codeExts: this.config.getCodeFileExtensions(),
      docExts: this.config.getDocFileExtensions(),
    };
  }

  /** Read + parse a transcript file, memoized by path+mtime. */
  private parseFile(path: string): TranscriptRecord[] {
    const mtimeMs = this.env?.mtimeMs(path) ?? mtimeOf(path);
    const cached = this.fileCache.get(path);
    if (cached !== undefined && cached.mtimeMs === mtimeMs) {
      return cached.result.records;
    }
    let result: ParseResult;
    try {
      result = readTranscriptFile(path);
    } catch {
      result = { records: [], skipped: 0 };
    }
    this.fileCache.set(path, { mtimeMs, result });
    return result.records;
  }

  private ensureDiscovered(): ClaudeSessionFiles[] {
    if (this.discovered === undefined) {
      this.discovered = discoverClaudeSessions(this.config, this.env);
    }
    return this.discovered;
  }

  private maxSessions(): number {
    const raw = this.config.getClaudeMaxSessions();
    if (!Number.isFinite(raw) || raw <= 0) {
      return 150;
    }
    return Math.floor(raw);
  }
}

/**
 * Build `agentId → friendly agent type` from a main transcript. Two sources are
 * joined: the spawn's `toolUseResult.agentType`, and — when that is absent (the
 * common case for `Agent`/`Workflow` spawns) — the spawning `tool_use`'s
 * `input.subagent_type`, reached via the result record's `tool_result.tool_use_id`.
 */
function buildAgentTypeIndex(mainRecords: TranscriptRecord[]): Map<string, string> {
  // tool_use.id → subagent_type carried on the spawn's input.
  const subTypeByToolUseId = new Map<string, string>();
  for (const record of mainRecords) {
    for (const block of contentBlocks(record.message)) {
      if (block.type !== 'tool_use' || typeof block.id !== 'string') {
        continue;
      }
      const input = block.input;
      if (input !== null && typeof input === 'object') {
        const subType = (input as Record<string, unknown>).subagent_type;
        if (typeof subType === 'string' && subType.length > 0) {
          subTypeByToolUseId.set(block.id, subType);
        }
      }
    }
  }

  const index = new Map<string, string>();
  for (const record of mainRecords) {
    const tr = record.toolUseResult;
    if (tr === undefined || typeof tr.agentId !== 'string') {
      continue;
    }
    let type =
      typeof tr.agentType === 'string' && tr.agentType.length > 0 ? tr.agentType : undefined;
    if (type === undefined) {
      // The result record's tool_result links back to the spawning tool_use id.
      for (const block of contentBlocks(record.message)) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const subType = subTypeByToolUseId.get(block.tool_use_id);
          if (subType !== undefined) {
            type = subType;
            break;
          }
        }
      }
    }
    if (type !== undefined) {
      index.set(tr.agentId, type);
    }
  }
  return index;
}

/** Resolve a sub-agent transcript's friendly type from its records / the index. */
function resolveAgentType(
  records: TranscriptRecord[],
  agentTypeById: Map<string, string>,
): string | undefined {
  for (const record of records) {
    if (typeof record.agentId === 'string') {
      const fromIndex = agentTypeById.get(record.agentId);
      if (fromIndex !== undefined) {
        return fromIndex;
      }
    }
    if (record.type === 'agent-name' && typeof record.agentName === 'string' && record.agentName.length > 0) {
      return record.agentName;
    }
  }
  return undefined;
}

/** Whether a model id is a real model (not the empty/`unknown` sentinel). */
function isRealModel(model: string): boolean {
  return model.length > 0 && model !== 'unknown';
}

/** The first non-empty `cwd` among records, for repository resolution. */
function firstCwd(records: TranscriptRecord[]): string | undefined {
  for (const record of records) {
    if (typeof record.cwd === 'string' && record.cwd.length > 0) {
      return record.cwd;
    }
  }
  return undefined;
}

function mtimeOf(path: string): number {
  try {
    return fs.statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Re-export so callers don't import the deep module path. */
export { UNKNOWN_REPOSITORY };
