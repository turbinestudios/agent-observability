import * as fs from 'node:fs';
import Database from 'better-sqlite3';
import { resolveDatabasePaths } from '@agent-observability/core/src/telemetry/paths';
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
 * The Copilot database the next index pass would open: the durable archive the
 * extension maintains when it exists (it keeps history Copilot's own rolling
 * database discards), else the first readable native/override database.
 *
 * Exported for the settings snapshot, so what the settings page reports can
 * never disagree with what the indexer actually opens.
 */
export function pickCopilotDatabase(config: Configuration): CopilotDatabaseCandidate | undefined {
  const archive = resolveArchiveDbPath(config);
  if (archive !== undefined && fs.existsSync(archive) && fs.statSync(archive).size > 0) {
    return { path: archive, archive: true, override: false };
  }
  for (const found of resolveDatabasePaths(config).databases) {
    if (fs.existsSync(found.path)) {
      return { path: found.path, archive: false, override: found.source === 'override' };
    }
  }
  return undefined;
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

export class CopilotIndexer {
  private readonly now: () => number;

  constructor(private readonly deps: CopilotIndexerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  run(): { discovered: number; hydrated: number; sourcePath?: string; skipped?: string } {
    if (!this.deps.config.isLocalTelemetryEnabled()) {
      return { discovered: 0, hydrated: 0, skipped: 'Copilot source is disabled' };
    }

    const candidate = pickCopilotDatabase(this.deps.config);
    if (candidate === undefined) {
      return { discovered: 0, hydrated: 0, skipped: 'No Copilot database found on this machine' };
    }

    let db: Database.Database;
    try {
      // readonly + fileMustExist: this is somebody else's live database and
      // must never be created, migrated, or written by us.
      db = new Database(candidate.path, { readonly: true, fileMustExist: true });
    } catch (err) {
      // Most often SQLITE_READONLY_CANTINIT: WAL mode needs to create a -shm
      // file, which a read-only open cannot do when none exists yet. Copilot
      // creates one as soon as it runs again, so this resolves itself.
      return {
        discovered: 0,
        hydrated: 0,
        skipped: `Could not open the Copilot database (${err instanceof Error ? err.message : String(err)})`,
      };
    }

    try {
      if (!hasSpansTable(db)) {
        return { discovered: 0, hydrated: 0, skipped: 'Copilot database has no spans table' };
      }

      // Most span groups in this database are not sessions a person would
      // recognize — tool-call ids and chat-helper traffic. Without this the
      // list is mostly noise: 435 rows here instead of the real handful.
      const started = this.startedSessions(db);

      const aggregates = (db.prepare(SESSIONS_SQL).all() as SessionAggregate[]).filter((a) =>
        started.has(a.session_id),
      );
      this.deps.onDiscovered?.(aggregates.length);
      if (aggregates.length === 0) {
        return { discovered: 0, hydrated: 0, sourcePath: candidate.path };
      }

      const repositories = this.resolveRepositories(db);
      const byWorkspace = this.workspaceRepositories();
      const titles = readCopilotTitles(this.deps.db, this.deps.config);
      const excluded = this.deps.config.getExcludedRepositories();

      const rows: SessionRow[] = [];
      for (const aggregate of aggregates) {
        // The span attribute wins when a session recorded one; plenty do not,
        // and those are the sessions that would otherwise read as "unknown".
        const repository =
          repositories.get(aggregate.session_id) ??
          byWorkspace.get(aggregate.session_id) ??
          'unknown';
        if (excluded.has(repository)) {
          continue;
        }
        rows.push(this.toRow(aggregate, repository, titles.get(aggregate.session_id)));
      }

      this.deps.db.upsertSessions(rows);
      this.deps.onRows?.(rows);
      this.deps.db.removeMissing('copilot', new Set(rows.map((r) => r.sessionId)));

      return { discovered: aggregates.length, hydrated: rows.length, sourcePath: candidate.path };
    } finally {
      db.close();
    }
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
      const sourcePaths = resolveDatabasePaths(this.deps.config).databases.map((d) => d.path);
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

  private toRow(
    aggregate: SessionAggregate,
    repository: string,
    title: { title: string; derived: boolean } | undefined,
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
      model: aggregate.model ?? 'unknown',
      agentModes: splitAgentNames(aggregate.agent_names),
      indexedAtMs: this.now(),
      pending: false,
    };
  }
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
