import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { resolveDatabasePaths, type PathEnvironment } from '@agent-observability/core/src/telemetry/paths';
import { aiuToUsd } from '@agent-observability/core/src/telemetry/pricing';
import { resolveArchiveDbPath } from '@agent-observability/core/src/otel/archivePaths';
import { sanitizeRepositoryUrl } from '@agent-observability/core/src/telemetry/repositoryUrl';
import { buildGlobalSessionRepositories } from '@agent-observability/core/src/telemetry/globalWorkspaceRepos';
import { titleStorageDirs } from '@agent-observability/core/src/telemetry/titleStore';
import { GitRemoteResolver } from '@agent-observability/core/src/claude/gitRemote';
import {
  CHAT_SESSION_CANDIDATES_SQL,
  CONVERSATION_ONLY_CANDIDATES_SQL,
  SESSION_KEY_EXPR,
  startedSessionSet,
  suggestionOnlySql,
} from '@agent-observability/core/src/telemetry/sessionFilter';
import type { Configuration } from '@agent-observability/core/src/config/configuration';
import type { SessionRow } from '../../shared/rpc';
import type { IndexDb } from './indexDb';
import { readCopilotTitles } from './copilotTitles';

/**
 * Indexes GitHub Copilot sessions out of Copilot's own SQLite database.
 *
 * The extension cannot read that file directly: `node-sqlite3-wasm` refuses a
 * database with WAL set, so it copies the whole thing — 300 MB on this machine —
 * replays the WAL by hand, and does it again whenever the source mtime moves.
 *
 * Here it is opened read-only, in place, with better-sqlite3, which speaks WAL
 * natively. The copy and the hand-written replay both disappear, and a refresh
 * becomes one aggregate query. Nothing is ever written to Copilot's file.
 */

/** Where to read Copilot spans from, in preference order. */
export interface CopilotDatabaseCandidate {
  path: string;
  /** The durable archive is preferred: it retains history Copilot rolls off. */
  archive: boolean;
  /** True when the path came from the user's `sqlitePath` override. */
  override: boolean;
}

/**
 * Every Copilot database the next index pass will read, in priority order: the
 * durable archive the extension maintains when it exists (it merges every
 * native source and keeps history Copilot's own rolling database discards),
 * else EVERY readable native/override database.
 *
 * Reading all of them matters on a machine with more than one VS Code install:
 * when only the first candidate was read, a stale stable-Code database could
 * hide the Insiders one holding all the real sessions.
 *
 * Exported for the settings snapshot, so what the settings page reports can
 * never disagree with what the indexer actually opens.
 */
export function pickCopilotDatabases(
  config: Configuration,
  environment?: PathEnvironment,
): CopilotDatabaseCandidate[] {
  const archive = resolveArchiveDbPath(config);
  if (archive !== undefined && fs.existsSync(archive) && fs.statSync(archive).size > 0) {
    return [{ path: archive, archive: true, override: false }];
  }
  const resolved =
    environment === undefined ? resolveDatabasePaths(config) : resolveDatabasePaths(config, environment);
  return resolved.databases.map((found) => ({
    path: found.path,
    archive: false,
    override: found.source === 'override',
  }));
}

/** The highest-priority candidate of {@link pickCopilotDatabases}, if any. */
export function pickCopilotDatabase(config: Configuration): CopilotDatabaseCandidate | undefined {
  const all = pickCopilotDatabases(config);
  return all.length > 0 ? all[0] : undefined;
}

export interface CopilotIndexerDeps {
  db: IndexDb;
  config: Configuration;
  onRows?: (rows: SessionRow[]) => void;
  onDiscovered?: (total: number) => void;
  /**
   * Resolves a folder to its sanitized git remote. Injectable so a test can
   * confine resolution instead of reading the machine's real checkouts.
   */
  gitRemote?: { resolve(localPath: string): string };
  /**
   * Where the platform keeps VS Code data. Injectable so a test can present
   * multiple database locations without scanning the real machine.
   */
  environment?: PathEnvironment;
  now?: () => number;
}

/** One session as aggregated by the query below. */
interface SessionAggregate {
  session_id: string;
  model: string | null;
  started_at: number | null;
  ended_at: number | null;
  duration_ms: number | null;
  span_count: number;
  llm_calls: number;
  tool_calls: number;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  total_cached_tokens: number | null;
  agent_names: string | null;
}

/**
 * Mirrors core's `sessions` view, plus the distinct agent names that become
 * agent modes. Reproduced here rather than selecting from the view because the
 * native Copilot database does not always define it.
 */
const SESSIONS_SQL = `
  SELECT
    COALESCE(conversation_id, chat_session_id) AS session_id,
    MAX(response_model) AS model,
    MIN(start_time_ms) AS started_at,
    MAX(end_time_ms) AS ended_at,
    MAX(end_time_ms) - MIN(start_time_ms) AS duration_ms,
    COUNT(*) AS span_count,
    SUM(CASE WHEN operation_name = 'chat' THEN 1 ELSE 0 END) AS llm_calls,
    SUM(CASE WHEN operation_name = 'execute_tool' THEN 1 ELSE 0 END) AS tool_calls,
    SUM(CASE WHEN operation_name = 'chat' THEN input_tokens ELSE 0 END) AS total_input_tokens,
    SUM(CASE WHEN operation_name = 'chat' THEN output_tokens ELSE 0 END) AS total_output_tokens,
    SUM(CASE WHEN operation_name = 'chat' THEN cached_tokens ELSE 0 END) AS total_cached_tokens,
    GROUP_CONCAT(DISTINCT agent_name) AS agent_names
  FROM spans
  WHERE COALESCE(conversation_id, chat_session_id) IS NOT NULL
  GROUP BY COALESCE(conversation_id, chat_session_id)
`;

/**
 * Repository per session. A session's repo attribute is sparse, so the most
 * recent non-empty value wins — matching how core resolves a session whose
 * remote was re-pointed partway through.
 */
const REPO_SQL = `
  SELECT COALESCE(s.conversation_id, s.chat_session_id) AS session_id,
         a.value AS value,
         s.start_time_ms AS start_time_ms
  FROM spans s
  JOIN span_attributes a
    ON a.span_id = s.span_id
   AND a.key IN ('copilot_chat.repo.remote_url', 'github.copilot.git.repository')
  WHERE a.value IS NOT NULL AND a.value <> ''
    AND COALESCE(s.conversation_id, s.chat_session_id) IS NOT NULL
  ORDER BY s.start_time_ms ASC
`;

/**
 * Billed premium-request usage per session: Σ nano-AIU over the session's chat
 * spans — the same attribute and scope core's detail path sums, so a row's cost
 * agrees with the detail view. A session with no AIU attribute at all yields no
 * row here and stays UNPRICED (n/a), which is a different statement from a
 * session whose recorded AIU sums to a genuine 0 (free/included calls).
 */
const AIU_SQL = `
  SELECT COALESCE(s.conversation_id, s.chat_session_id) AS session_id,
         SUM(CAST(a.value AS INTEGER)) AS aiu_nano
  FROM spans s
  JOIN span_attributes a
    ON a.span_id = s.span_id
   AND a.key = 'copilot_chat.copilot_usage_nano_aiu'
  WHERE s.operation_name = 'chat'
    AND COALESCE(s.conversation_id, s.chat_session_id) IS NOT NULL
  GROUP BY COALESCE(s.conversation_id, s.chat_session_id)
`;

export class CopilotIndexer {
  private readonly now: () => number;

  constructor(private readonly deps: CopilotIndexerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  run(): { discovered: number; hydrated: number; sourcePath?: string; skipped?: string } {
    if (!this.deps.config.isLocalTelemetryEnabled()) {
      return { discovered: 0, hydrated: 0, skipped: 'Copilot source is disabled' };
    }

    const candidates = pickCopilotDatabases(this.deps.config, this.deps.environment);
    if (candidates.length === 0) {
      return { discovered: 0, hydrated: 0, skipped: 'No Copilot database found on this machine' };
    }

    // Read every candidate, merging by session id with the earlier (higher
    // priority) database winning. One database failing to open must not hide
    // the others: a machine with two VS Code installs keeps its sessions even
    // when one file is momentarily unopenable.
    const aggregates = new Map<string, SessionAggregate>();
    const repositories = new Map<string, string>();
    const aiu = new Map<string, number>();
    const opened: string[] = [];
    const problems: string[] = [];

    for (const candidate of candidates) {
      let db: Database.Database;
      try {
        // readonly + fileMustExist: this is somebody else's live database and
        // must never be created, migrated, or written by us.
        db = new Database(candidate.path, { readonly: true, fileMustExist: true });
      } catch (err) {
        // Most often SQLITE_READONLY_CANTINIT: WAL mode needs to create a -shm
        // file, which a read-only open cannot do when none exists yet. Copilot
        // creates one as soon as it runs again, so this resolves itself.
        problems.push(`Could not open the database at ${candidate.path} (${errorMessage(err)})`);
        continue;
      }
      try {
        if (!hasSpansTable(db)) {
          problems.push(`No spans table in ${candidate.path}`);
          continue;
        }

        // Most span groups in this database are not sessions a person would
        // recognize — tool-call ids and chat-helper traffic. Without this the
        // list is mostly noise: 435 rows here instead of the real handful.
        const started = this.startedSessions(db);
        for (const aggregate of db.prepare(SESSIONS_SQL).all() as SessionAggregate[]) {
          if (started.has(aggregate.session_id) && !aggregates.has(aggregate.session_id)) {
            aggregates.set(aggregate.session_id, aggregate);
          }
        }
        for (const [id, repository] of this.resolveRepositories(db)) {
          if (!repositories.has(id)) {
            repositories.set(id, repository);
          }
        }
        for (const [id, nano] of this.sessionAiu(db)) {
          if (!aiu.has(id)) {
            aiu.set(id, nano);
          }
        }
        opened.push(candidate.path);
      } catch (err) {
        problems.push(`Could not read ${candidate.path} (${errorMessage(err)})`);
      } finally {
        db.close();
      }
    }

    if (opened.length === 0) {
      return { discovered: 0, hydrated: 0, skipped: problems.join(' · ') };
    }

    const sourcePath = opened.join(' · ');
    this.deps.onDiscovered?.(aggregates.size);
    if (aggregates.size === 0) {
      // Found but empty is a different first-run situation from not found, and
      // saying so is what tells a new user the wiring works.
      return {
        discovered: 0,
        hydrated: 0,
        sourcePath,
        skipped: 'the database has no agent sessions yet — use Copilot chat once and refresh',
      };
    }

    const byWorkspace = this.workspaceRepositories();
    const titles = readCopilotTitles(this.deps.db, this.deps.config, this.deps.environment);
    const excluded = this.deps.config.getExcludedRepositories();

    const rows: SessionRow[] = [];
    for (const aggregate of aggregates.values()) {
      // The span attribute wins when a session recorded one; plenty do not,
      // and those are the sessions that would otherwise read as "unknown".
      const repository =
        repositories.get(aggregate.session_id) ??
        byWorkspace.get(aggregate.session_id) ??
        'unknown';
      if (excluded.has(repository)) {
        continue;
      }
      rows.push(
        this.toRow(
          aggregate,
          repository,
          titles.get(aggregate.session_id),
          aiu.get(aggregate.session_id),
        ),
      );
    }

    this.deps.db.upsertSessions(rows);
    this.deps.onRows?.(rows);
    this.deps.db.removeMissing('copilot', new Set(rows.map((r) => r.sessionId)));

    return { discovered: aggregates.size, hydrated: rows.length, sourcePath };
  }

  /**
   * The set of span groups that count as real sessions, using core's shared
   * definition so this and the extension cannot drift apart.
   */
  private startedSessions(db: Database.Database): Set<string> {
    type Row = { session_key: string };
    const chatSessions = db.prepare(CHAT_SESSION_CANDIDATES_SQL).all() as Row[];
    const conversationOnly = db.prepare(CONVERSATION_ONLY_CANDIDATES_SQL).all() as Row[];

    const suggestionByChatSession = new Set(
      (db.prepare(suggestionOnlySql('chat_session_id')).all() as Row[]).map((r) => r.session_key),
    );
    const suggestionByKey =
      conversationOnly.length === 0
        ? new Set<string>()
        : new Set(
            (db.prepare(suggestionOnlySql(SESSION_KEY_EXPR)).all() as Row[]).map((r) => r.session_key),
          );

    return startedSessionSet(chatSessions, conversationOnly, suggestionByChatSession, suggestionByKey);
  }

  /**
   * Session id → repository, derived from VS Code's own workspace stores.
   *
   * Copilot records the repository on a span only sometimes, so a session run
   * in a workspace whose spans happened not to carry it lands in "unknown"
   * despite the repository being perfectly well known. Each workspace store
   * names its folder and lists the chat sessions held there, which is enough to
   * resolve those from the folder's git remote instead.
   *
   * Best-effort: the scan can reach WSL folders over UNC paths that are slow or
   * unavailable, and a Copilot list without repositories still beats no list.
   */
  private workspaceRepositories(): Map<string, string> {
    const map = new Map<string, string>();
    try {
      const { config, environment } = this.deps;
      const resolved =
        environment === undefined ? resolveDatabasePaths(config) : resolveDatabasePaths(config, environment);
      const sourcePaths = resolved.databases.map((d) => d.path);
      const gitRemote = this.deps.gitRemote ?? new GitRemoteResolver();
      for (const root of titleStorageDirs(sourcePaths)) {
        for (const [id, repository] of buildGlobalSessionRepositories(root, (p) =>
          gitRemote.resolve(p),
        )) {
          map.set(id, repository);
        }
      }
    } catch {
      // Leave what was gathered; sessions simply keep their own attribute.
    }
    return map;
  }

  private resolveRepositories(db: Database.Database): Map<string, string> {
    const rows = db.prepare(REPO_SQL).all() as { session_id: string; value: string }[];
    const resolved = new Map<string, string>();
    for (const row of rows) {
      // Ordered oldest-first, so a later value overwrites an earlier one.
      const sanitized = sanitizeRepositoryUrl(row.value);
      if (sanitized !== undefined) {
        resolved.set(row.session_id, sanitized);
      }
    }
    return resolved;
  }

  /**
   * Session id → Σ nano-AIU over its chat spans. Best-effort: an older or
   * partial database without `span_attributes` leaves every session unpriced
   * (n/a) rather than failing the index pass.
   */
  private sessionAiu(db: Database.Database): Map<string, number> {
    const map = new Map<string, number>();
    try {
      const rows = db.prepare(AIU_SQL).all() as { session_id: string; aiu_nano: number | null }[];
      for (const row of rows) {
        if (row.aiu_nano !== null) {
          map.set(row.session_id, row.aiu_nano);
        }
      }
    } catch {
      // No span_attributes table (or an unreadable one): cost degrades to n/a.
    }
    return map;
  }

  private toRow(
    aggregate: SessionAggregate,
    repository: string,
    title: { title: string; derived: boolean } | undefined,
    aiuNano: number | undefined,
  ): SessionRow {
    return {
      source: 'copilot',
      sessionId: aggregate.session_id,
      repository,
      title: title?.title,
      titleDerived: title?.derived,
      startedAtMs: aggregate.started_at ?? 0,
      endedAtMs: aggregate.ended_at ?? 0,
      durationMs: aggregate.duration_ms ?? 0,
      interactionCount: aggregate.span_count,
      llmCalls: aggregate.llm_calls,
      toolCalls: aggregate.tool_calls,
      inputTokens: aggregate.total_input_tokens ?? 0,
      outputTokens: aggregate.total_output_tokens ?? 0,
      cachedTokens: aggregate.total_cached_tokens ?? 0,
      // Micro-USD derived from the billed AIU at the fixed published rate — the
      // same conversion the detail view shows, so the two figures agree.
      costMicros: aiuNano === undefined ? undefined : Math.round(aiuToUsd(aiuNano) * 1_000_000),
      model: aggregate.model ?? 'unknown',
      agentModes: splitAgentNames(aggregate.agent_names),
      indexedAtMs: this.now(),
      pending: false,
    };
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function hasSpansTable(db: Database.Database): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'spans'`)
    .get();
  return row !== undefined;
}

function splitAgentNames(raw: string | null): string[] {
  if (raw === null || raw.length === 0) {
    return [];
  }
  return [...new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
}
