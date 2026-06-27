import { Configuration } from '../config/configuration';
import { resolveDatabasePaths, DatabaseSource, PathConfig, PathEnvironment } from './paths';
import { createReadonlySnapshot, ReadonlySnapshot, sourceMtime } from './snapshot';
import { TelemetryDatabase, SchemaMismatchError } from './database';
import {
  SessionTitleInfo,
  readSessionTitles,
  workspaceStorageDirFor,
} from './sessionTitles';
import { readChatSessionIndexTitles } from './chatSessionIndex';
import { AggregationRow } from '../aggregate/aggregator';
import {
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionSummary,
  SessionDetail,
} from './models';

/**
 * High-level facade the view providers depend on.
 *
 * Responsibilities:
 * - Honor the `agentObservability.localTelemetry.enabled` feature flag.
 * - Resolve every reachable local DB (stable, insiders, server variants),
 *   snapshot each read-only, open + validate, and manage the snapshot +
 *   connection lifecycles (re-snapshot on refresh, skip when a source mtime
 *   is unchanged).
 * - MERGE query results across the open databases so the views show one
 *   combined picture of agent activity. Sessions are disjoint across
 *   variants (a session runs in exactly one), so merging is concatenation +
 *   re-sort; repository rollups are summed by sanitized repository name.
 * - Classify failures into a small typed {@link Result} the views render as a
 *   single explanatory row — never throwing into the tree UI. A source that
 *   fails to open is skipped as long as at least one database opens; only a
 *   total failure surfaces as an error.
 *
 * Phase 3 reuses {@link getSessionInteractions}; Phase 5 reuses the underlying
 * queries for aggregation.
 */

/** Failure reasons surfaced to the UI. */
export type FailureReason =
  | 'disabled'
  | 'missingDb'
  | 'permission'
  | 'schemaMismatch'
  | 'error';

/** Discriminated result the views consume without try/catch. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; reason: FailureReason; message: string };

/** Minimal config surface the service needs (satisfied by {@link Configuration}). */
export interface ServiceConfig extends PathConfig {
  isLocalTelemetryEnabled(): boolean;
  /** Extensions classified as source code for the LoC/nLoC metric. */
  getCodeFileExtensions(): string[];
  /** Extensions classified as documentation for the LoD/nLoD metric. */
  getDocFileExtensions(): string[];
}

interface CacheEntry {
  overview?: OverviewMetrics;
  repositories?: RepositorySummary[];
  /** Cache key: `${repository ?? '*'}::${limit ?? '*'}`. */
  sessions: Map<string, SessionSummary[]>;
}

/**
 * A live, opened snapshot + its source mtime, kept between queries. One per
 * resolved source database; the service holds them in resolution priority
 * order. The LOCAL-ONLY title lookups are cached per handle (each source DB
 * has its own sibling `workspaceStorage` title store) and live exactly as
 * long as the snapshot.
 */
interface OpenHandle {
  snapshot: ReadonlySnapshot;
  db: TelemetryDatabase;
  /** Source DB path the snapshot was taken from. */
  sourcePath: string;
  /** Which resolver candidate produced this source, for diagnostics. */
  source: DatabaseSource;
  /**
   * LOCAL-ONLY session-name lookup (sessionId → title), read lazily from the
   * Copilot chat-session store beside THIS source's telemetry DB.
   */
  titles?: Map<string, SessionTitleInfo>;
  /**
   * Session key → its UUID `chat_session_id` (when distinct), so a title keyed
   * by the chat-session id resolves even when the session key is a per-turn
   * `conversation_id`. Cached per snapshot alongside {@link titles}.
   */
  chatSessionIds?: Map<string, string>;
}

export class TelemetryService {
  private readonly config: ServiceConfig;
  private readonly environment: PathEnvironment | undefined;
  private handles: OpenHandle[] = [];
  private cache: CacheEntry = { sessions: new Map() };

  constructor(config: ServiceConfig | Configuration, environment?: PathEnvironment) {
    this.config = config;
    this.environment = environment;
  }

  /**
   * Drop the cached snapshots, connections and query cache. Called on refresh
   * and on dispose. Re-acquisition happens lazily on the next query.
   */
  refresh(): void {
    this.disposeHandles();
    this.cache = { sessions: new Map() };
  }

  /** Tear down the snapshots + connections. Call from extension deactivate(). */
  dispose(): void {
    this.disposeHandles();
  }

  /** Overview metrics, merged across every open source database. */
  getOverview(sinceMs?: number): Result<OverviewMetrics> {
    return this.withDatabases((handles) => {
      if (sinceMs === undefined && this.cache.overview !== undefined) {
        return this.cache.overview;
      }
      const value = mergeOverviews(handles, sinceMs);
      if (sinceMs === undefined) {
        this.cache.overview = value;
      }
      return value;
    });
  }

  /**
   * Repository summaries (two-level Sessions tree roots), merged by sanitized
   * repository name across the source databases: the same repository worked on
   * from Windows and from WSL appears as ONE node with summed counts.
   */
  listRepositories(): Result<RepositorySummary[]> {
    return this.withDatabases((handles) => {
      if (this.cache.repositories !== undefined) {
        return this.cache.repositories;
      }
      const merged = new Map<string, RepositorySummary>();
      for (const handle of handles) {
        for (const repo of handle.db.listRepositories()) {
          const acc = merged.get(repo.repository);
          if (acc === undefined) {
            merged.set(repo.repository, { ...repo, models: [...repo.models] });
          } else {
            acc.sessionCount += repo.sessionCount;
            acc.interactionCount += repo.interactionCount;
            acc.models = [...new Set([...acc.models, ...repo.models])].sort();
            acc.lastActivityMs = Math.max(acc.lastActivityMs, repo.lastActivityMs);
          }
        }
      }
      const value = [...merged.values()].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
      this.cache.repositories = value;
      return value;
    });
  }

  /**
   * Session summaries, optionally filtered to a repository, merged across the
   * source databases newest-first. Session ids are unique per environment;
   * a duplicate id across sources (never expected in practice) keeps the
   * higher-priority source's row.
   */
  listSessions(repository?: string, limit?: number): Result<SessionSummary[]> {
    return this.withDatabases((handles) => {
      const key = `${repository ?? '*'}::${limit ?? '*'}`;
      const cached = this.cache.sessions.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const seen = new Set<string>();
      const all: SessionSummary[] = [];
      for (const handle of handles) {
        // Each source is capped at `limit` too: after the merged sort, no row
        // beyond a single source's newest `limit` can make the final cut.
        for (const session of this.applyTitles(handle.db.listSessions(repository, limit), handle)) {
          if (!seen.has(session.sessionId)) {
            seen.add(session.sessionId);
            all.push(session);
          }
        }
      }
      all.sort((a, b) => b.startedAtMs - a.startedAtMs);
      const value = limit !== undefined ? all.slice(0, limit) : all;
      this.cache.sessions.set(key, value);
      return value;
    });
  }

  /**
   * Attach LOCAL-ONLY session names (from the Copilot chat-session store beside
   * THIS handle's source DB) to session summaries. A no-op when no titles are
   * available (e.g. a custom `sqlitePath` override or fixture that has no
   * sibling `workspaceStorage`).
   *
   * Resolves by the session key first; when that misses (the key is a per-turn
   * `conversation_id`, not the chat-session id), retries via the session's UUID
   * `chat_session_id`, which is what the title store is keyed by.
   */
  private applyTitles(sessions: SessionSummary[], handle: OpenHandle): SessionSummary[] {
    const titles = ensureSessionTitles(handle);
    if (titles.size === 0) {
      return sessions;
    }
    const chatSessionIds = ensureChatSessionIds(handle);
    return sessions.map((session) => {
      const chatId = chatSessionIds.get(session.sessionId);
      const info =
        titles.get(session.sessionId) ?? (chatId !== undefined ? titles.get(chatId) : undefined);
      return info === undefined
        ? session
        : { ...session, title: info.title, titleDerived: info.derived };
    });
  }

  /** Ordered interactions for a session (Phase 3 detail). Not cached. */
  getSessionInteractions(sessionKey: string): Result<Interaction[]> {
    return this.withDatabases((handles) => {
      for (const handle of handles) {
        const value = handle.db.getSessionInteractions(sessionKey);
        if (value.length > 0) {
          return value;
        }
      }
      return [];
    });
  }

  /**
   * LOCAL-ONLY raw span-attribute values for a session, keyed by span id, for the
   * given content-predicate attribute. Used exclusively by the local
   * workflow-deviation path to evaluate a
   * {@link ../deviation/models.ContentPredicate} on-machine; the values are never
   * cached, logged, or uploaded, and never reach the aggregate/sync path.
   */
  getSpanAttributes(sessionKey: string, attributeKey: string): Result<Map<string, string>> {
    return this.withDatabases((handles) => {
      for (const handle of handles) {
        const value = handle.db.getAttributesBySpan(sessionKey, attributeKey);
        if (value.size > 0) {
          return value;
        }
      }
      return new Map<string, string>();
    });
  }

  /**
   * LOCAL-ONLY discovery/customization events for context-file analysis. Returns
   * the raw event_details strings from the agent tree's `core_event` spans.
   */
  getContextDiscoveryEvents(sessionKey: string): Result<Array<{
    spanName: string;
    eventDetails: string;
    eventCategory: string;
    conversationId: string | null;
    chatSessionId: string | null;
    agentName: string | null;
    debugLabel: string | null;
  }>> {
    return this.withDatabases((handles) => {
      for (const handle of handles) {
        const value = handle.db.getContextDiscoveryEvents(sessionKey);
        if (value.length > 0) {
          return value;
        }
      }
      return [];
    });
  }

  /**
   * LOCAL-ONLY tool-call file reads targeting context-file paths. Returns parsed
   * file paths from read_file tool calls on context directories.
   */
  getContextToolReads(sessionKey: string): Result<Array<{
    filePath: string;
    conversationId: string | null;
    chatSessionId: string | null;
    agentName: string | null;
    debugLabel: string | null;
  }>> {
    return this.withDatabases((handles) => {
      for (const handle of handles) {
        const value = handle.db.getContextToolReads(sessionKey);
        if (value.length > 0) {
          return value;
        }
      }
      return [];
    });
  }

  /**
   * LOCAL-ONLY system_instructions content per LLM span for context-file size
   * estimation. Returns raw system prompt text keyed by span_id.
   */
  getSystemInstructionsBySpan(sessionKey: string): Result<Map<string, {
    value: string;
    conversationId: string | null;
    chatSessionId: string | null;
    inputTokens: number;
    agentName: string | null;
    debugLabel: string | null;
  }>> {
    return this.withDatabases((handles) => {
      for (const handle of handles) {
        const value = handle.db.getSystemInstructionsBySpan(sessionKey);
        if (value.size > 0) {
          return value;
        }
      }
      return new Map();
    });
  }

  /**
   * LOCAL-ONLY: map from `chat_session_id` to the friendly agent name for each
   * subagent in the session tree. Used by context analysis to label partitions.
   */
  getSubagentNames(sessionKey: string): Result<Map<string, string>> {
    return this.withDatabases((handles) => {
      for (const handle of handles) {
        const value = handle.db.getSubagentNames(sessionKey);
        if (value.size > 0) {
          return value;
        }
      }
      return new Map<string, string>();
    });
  }

  /**
   * Safe per-span aggregation rows for the Phase 5 cloud aggregate engine,
   * optionally bounded to `[sinceMs, untilMs)` on span start time, concatenated
   * across every source database (sessions are disjoint per environment, so
   * concatenation never double-counts a span). Carries ONLY non-sensitive
   * metadata (sanitized repository, mapped mode/tool, counts, tokens); never
   * any raw-content attribute. Not cached — aggregation is an on-demand
   * operation (preview / scheduled sync).
   */
  getAggregationRows(sinceMs?: number, untilMs?: number): Result<AggregationRow[]> {
    return this.withDatabases((handles) =>
      handles.flatMap((handle) => handle.db.getAggregationRows(sinceMs, untilMs)),
    );
  }

  /**
   * The distinct sanitized repositories present in local telemetry, sorted.
   * Drives the "Choose Repositories to Sync" picker so users select from what
   * actually exists rather than typing canonical URLs. Includes the literal
   * `unknown` when sessions have no detected git remote. Reads on-machine data
   * only — nothing is uploaded.
   */
  getDistinctRepositories(): Result<string[]> {
    const rows = this.getAggregationRows();
    if (!rows.ok) {
      return rows;
    }
    const repositories = new Set<string>();
    for (const row of rows.value) {
      repositories.add(row.repository);
    }
    return { ok: true, value: [...repositories].sort() };
  }

  /**
   * Full session drill-down for the LOCAL detail panel: summary header plus a
   * chronological timeline that MAY carry local-only raw content
   * (`userRequest`). Not cached. The session is looked up in each source
   * database in priority order; the first that knows it wins. The detail panel
   * renders the result locally (HTML-escaped); the content never crosses any
   * networked path.
   *
   * Returns a `missingDb`-classified failure shape when the session is absent
   * from every source (no spans) so the panel can render a single explanatory
   * message.
   */
  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    // LoC/LoD classification lists come from local settings; passed down so the
    // raw tool arguments are parsed into counts inside the DB layer and never
    // surfaced to the service or beyond.
    const codeExts = this.config.getCodeFileExtensions();
    const docExts = this.config.getDocFileExtensions();
    return this.withDatabases((handles) => {
      for (const handle of handles) {
        const detail = handle.db.getSessionDetail(sessionKey, codeExts, docExts);
        if (detail !== undefined) {
          return detail;
        }
      }
      throw sessionNotFoundError(sessionKey);
    });
  }

  /**
   * Acquire (or reuse) the open databases and run `fn`, mapping any failure to
   * a typed {@link Result}. This is the single place that opens the DBs and
   * classifies errors, so every public method stays a small merge.
   */
  private withDatabases<T>(fn: (handles: OpenHandle[]) => T): Result<T> {
    if (!this.config.isLocalTelemetryEnabled()) {
      return {
        ok: false,
        reason: 'disabled',
        message: 'Local telemetry is disabled.',
      };
    }

    let handles: OpenHandle[];
    try {
      handles = this.ensureOpen();
    } catch (err) {
      return this.classify(err);
    }

    try {
      return { ok: true, value: fn(handles) };
    } catch (err) {
      // A query-time failure (e.g. a connection went away). Drop the handles so
      // a later refresh re-snapshots cleanly, then classify.
      this.disposeHandles();
      return this.classify(err);
    }
  }

  /**
   * Ensure an open, schema-valid handle per resolved source database,
   * re-snapshotting a source only when its mtime has changed since the last
   * snapshot (or there is no handle for it). Sources that fail to open are
   * skipped so one broken environment (e.g. an unreachable WSL share) never
   * hides the others; the first failure is rethrown only when NO source opens.
   *
   * @throws a typed error the caller classifies: a `{ code: 'ENOENT' }`-shaped
   *   error for a missing DB, the native EACCES/EPERM error, or
   *   {@link SchemaMismatchError}.
   */
  private ensureOpen(): OpenHandle[] {
    const resolved = resolveDatabasePaths(this.config, this.environment);

    // When nothing is readable anywhere, still attempt the denied-but-present
    // candidate so the precise EACCES/EPERM surfaces (snapshot copy throws).
    const targets =
      resolved.databases.length > 0
        ? resolved.databases
        : resolved.primary.path !== undefined && resolved.primary.exists
          ? [{ path: resolved.primary.path, source: resolved.primary.source }]
          : undefined;
    if (targets === undefined) {
      this.disposeHandles();
      throw missingDbError(resolved.primary.path);
    }

    const previous = new Map(this.handles.map((h) => [h.sourcePath, h]));
    const next: OpenHandle[] = [];
    let changed = false;
    let firstError: unknown;

    for (const target of targets) {
      const existing = previous.get(target.path);
      if (existing !== undefined) {
        previous.delete(target.path);
        const current = sourceMtime(target.path);
        if (current !== undefined && current === existing.snapshot.sourceMtimeMs) {
          next.push(existing);
          continue;
        }
        // Source changed (or vanished) — drop the stale handle and re-snapshot.
        disposeHandle(existing);
        changed = true;
      }
      try {
        const snapshot = createReadonlySnapshot(target.path);
        let db: TelemetryDatabase;
        try {
          db = TelemetryDatabase.open(snapshot.dbPath);
        } catch (err) {
          snapshot.dispose();
          throw err;
        }
        next.push({ snapshot, db, sourcePath: target.path, source: target.source });
        changed = true;
      } catch (err) {
        if (firstError === undefined) {
          firstError = err;
        }
      }
    }

    // Sources that vanished from resolution release their snapshots.
    for (const stale of previous.values()) {
      disposeHandle(stale);
      changed = true;
    }

    this.handles = next;
    if (next.length === 0) {
      throw firstError ?? missingDbError(resolved.primary.path);
    }
    if (changed) {
      // A fresh / dropped snapshot invalidates the merged query cache.
      this.cache = { sessions: new Map() };
    }
    return next;
  }

  private disposeHandles(): void {
    const handles = this.handles;
    this.handles = [];
    for (const handle of handles) {
      disposeHandle(handle);
    }
  }

  /** Map a thrown error to a typed failure {@link Result}. */
  private classify(err: unknown): Result<never> {
    if (err instanceof SchemaMismatchError) {
      return {
        ok: false,
        reason: 'schemaMismatch',
        message: err.message,
      };
    }
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return {
        ok: false,
        reason: 'missingDb',
        message: 'Copilot telemetry database not found.',
      };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        ok: false,
        reason: 'permission',
        message: 'Permission denied reading the Copilot telemetry database.',
      };
    }
    // node-sqlite3-wasm throws a SQLite3Error ("file is not a database") for a
    // non-DB / corrupt file; treat a failure to read a present-but-invalid file
    // as a schema mismatch rather than an opaque crash.
    const message = err instanceof Error ? err.message : String(err);
    if (/not a database|file is not a database|malformed|disk image is malformed/i.test(message)) {
      return {
        ok: false,
        reason: 'schemaMismatch',
        message: 'Telemetry database is not a recognized SQLite database.',
      };
    }
    return { ok: false, reason: 'error', message };
  }
}

/** Tear down one handle's connection + snapshot. */
function disposeHandle(handle: OpenHandle): void {
  handle.db.close();
  handle.snapshot.dispose();
}

/** Build (once per snapshot) a handle's sessionId → title lookup, cached.
 *
 * The authoritative auto-generated title lives in each workspace's
 * `state.vscdb` chat-session index; the per-session JSONL `customTitle` /
 * first-request fallback ({@link readSessionTitles}) is layered UNDER it,
 * covering older sessions the rolling index no longer lists. Precedence on a
 * clash: `state.vscdb` index title (non-derived) > JSONL `customTitle` >
 * derived.
 */
function ensureSessionTitles(handle: OpenHandle): Map<string, SessionTitleInfo> {
  if (handle.titles !== undefined) {
    return handle.titles;
  }
  const dir = workspaceStorageDirFor(handle.sourcePath);
  const titles = dir !== undefined ? readSessionTitles(dir) : new Map<string, SessionTitleInfo>();
  if (dir !== undefined) {
    // Override JSONL entries with the authoritative index title (non-derived).
    for (const [id, title] of readChatSessionIndexTitles(dir)) {
      titles.set(id, { title, derived: false });
    }
  }
  handle.titles = titles;
  return titles;
}

/** Build (once per snapshot) a handle's session-key → chat-session-id lookup, cached. */
function ensureChatSessionIds(handle: OpenHandle): Map<string, string> {
  if (handle.chatSessionIds === undefined) {
    handle.chatSessionIds = handle.db.chatSessionIdBySessionKey();
  }
  return handle.chatSessionIds;
}

/**
 * Merge per-source overview metrics into one. Pure sums for the additive
 * counters (sessions/spans are disjoint across environments), an
 * interaction-weighted mean for the average duration, and a NAME-level union
 * for the distinct repository/model counts so an environment-spanning
 * repository or model is counted once.
 */
function mergeOverviews(handles: OpenHandle[], sinceMs?: number): OverviewMetrics {
  if (handles.length === 1) {
    return handles[0].db.getOverviewMetrics(sinceMs);
  }

  const merged: OverviewMetrics = {
    totalInteractions: 0,
    totalSessions: 0,
    totalRepositories: 0,
    totalModels: 0,
    avgDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    errorCount: 0,
  };
  const models = new Set<string>();
  const repositories = new Set<string>();
  let durationWeightedSum = 0;

  for (const handle of handles) {
    const overview = handle.db.getOverviewMetrics(sinceMs);
    merged.totalInteractions += overview.totalInteractions;
    merged.totalSessions += overview.totalSessions;
    merged.inputTokens += overview.inputTokens;
    merged.outputTokens += overview.outputTokens;
    merged.cachedTokens += overview.cachedTokens;
    merged.errorCount += overview.errorCount;
    durationWeightedSum += overview.avgDurationMs * overview.totalInteractions;

    const dimensions = handle.db.getOverviewDimensions(sinceMs);
    for (const model of dimensions.models) {
      models.add(model);
    }
    for (const repository of dimensions.repositories) {
      repositories.add(repository);
    }
  }

  merged.totalModels = models.size;
  merged.totalRepositories = repositories.size;
  merged.avgDurationMs =
    merged.totalInteractions > 0 ? Math.round(durationWeightedSum / merged.totalInteractions) : 0;
  return merged;
}

/** Build an ENOENT-shaped error so the classifier maps a missing session. */
function sessionNotFoundError(sessionKey: string): NodeJS.ErrnoException {
  const err = new Error(`No interactions found for session ${sessionKey}.`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

/** Build an ENOENT-shaped error so the classifier maps it to `missingDb`. */
function missingDbError(attemptedPath: string | undefined): NodeJS.ErrnoException {
  const err = new Error(
    attemptedPath !== undefined
      ? `Copilot telemetry database not found at ${attemptedPath}.`
      : 'Could not determine the Copilot telemetry database location.',
  ) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}
