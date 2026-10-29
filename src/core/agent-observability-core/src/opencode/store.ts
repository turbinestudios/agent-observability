import * as fs from 'node:fs';
import { Database } from 'node-sqlite3-wasm';
import { isContextPath } from '../claude/claudeContextDiscovery';
import { createReadonlySnapshot, type SnapshotOptions } from '../telemetry/snapshot';

/**
 * Reads OpenCode's `opencode.db` (see `./paths.ts`) into plain rows.
 *
 * OpenCode keeps the file in WAL mode, so it is read through the same
 * private snapshot copy as every other SQLite store; the original is never
 * opened. From the JSON `data` columns only the fields named below are
 * read: never tool output, never reasoning text, never the `account`,
 * `credential` or `control_account` tables. Of tool input exactly two
 * fields are read, for the Context Analysis tab: a `skill` call's skill id,
 * and a `read` call's path when that path is a context file (AGENTS.md,
 * SKILL.md, …); any other path is dropped on the spot. Instruction files
 * are kept as path and length, never their text.
 *
 * Two layouts exist in the same file. OpenCode 2.x writes `session_v2` and
 * `session_message` (one row per user or assistant message in `seq`
 * order, tool calls inline in the assistant message's `content`) and
 * migrates the 1.x rows into them. Earlier builds have only `session`,
 * `message` and `part`. The v2 tables are read whenever they exist; the
 * legacy ones only when they do not, so nothing is counted twice.
 */

export interface OpencodeSessionRow {
  id: string;
  parentId?: string;
  title?: string;
  directory?: string;
  worktree?: string;
  version?: string;
  createdMs: number;
  updatedMs: number;
}

export interface OpencodeMessageRow {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant';
  createdMs: number;
  completedMs?: number;
  /** The user message's chosen agent (`build`, `plan`, …) or the assistant's. */
  agent?: string;
  providerId?: string;
  modelId?: string;
  /** Set on assistant messages: the user message it answers. */
  parentId?: string;
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** USD as OpenCode recorded it; absent when the message carries none. */
  cost?: number;
  error?: string;
}

export interface OpencodeToolPart {
  messageId: string;
  sessionId: string;
  tool: string;
  status?: string;
  startMs: number;
  endMs?: number;
  /** A `skill` call's skill id. */
  skillId?: string;
  /** A `read` call's target, kept only when it is a context file. */
  contextPath?: string;
}

/**
 * An instruction file OpenCode put in a session's context: the files behind
 * its `core/instructions` block (AGENTS.md, CLAUDE.md, configured
 * instructions), and nested AGENTS.md files loaded on the way as the agent
 * worked in a sub-folder. `chars` is the length of what was loaded.
 */
export interface OpencodeInstructionLoad {
  sessionId: string;
  path: string;
  chars?: number;
  via: 'session' | 'nested';
}

export interface OpencodeTextPart {
  messageId: string;
  sessionId: string;
  text: string;
}

export interface OpencodeStore {
  sessions: OpencodeSessionRow[];
  messages: OpencodeMessageRow[];
  tools: OpencodeToolPart[];
  texts: OpencodeTextPart[];
  instructions: OpencodeInstructionLoad[];
}

/** Caps one text part held in memory; a pasted log can run to megabytes. */
const TEXT_MAX_CHARS = 20_000;

const LEGACY = {
  sessions: `SELECT s.id AS id, s.parent_id AS parentId, s.title AS title, s.directory AS directory,
  s.version AS version, s.time_created AS createdMs, s.time_updated AS updatedMs, p.worktree AS worktree
  FROM session s LEFT JOIN project p ON p.id = s.project_id`,
  messages: `SELECT id, session_id AS sessionId, time_created AS createdMs,
  json_extract(data, '$.role') AS role,
  json_extract(data, '$.time.completed') AS completedMs,
  json_extract(data, '$.agent') AS agent,
  COALESCE(json_extract(data, '$.providerID'), json_extract(data, '$.model.providerID')) AS providerId,
  COALESCE(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID')) AS modelId,
  json_extract(data, '$.parentID') AS parentId,
  json_extract(data, '$.tokens.input') AS input,
  json_extract(data, '$.tokens.output') AS output,
  json_extract(data, '$.tokens.reasoning') AS reasoning,
  json_extract(data, '$.tokens.cache.read') AS cacheRead,
  json_extract(data, '$.tokens.cache.write') AS cacheWrite,
  json_extract(data, '$.cost') AS cost,
  json_extract(data, '$.error.name') AS error
  FROM message ORDER BY session_id, time_created, id`,
  tools: `SELECT message_id AS messageId, session_id AS sessionId, time_created AS createdMs,
  json_extract(data, '$.tool') AS tool,
  json_extract(data, '$.state.status') AS status,
  json_extract(data, '$.state.time.start') AS startMs,
  json_extract(data, '$.state.time.end') AS endMs,
  NULL AS skillId,
  CASE WHEN json_extract(data, '$.tool') = 'read' THEN json_extract(data, '$.state.input.filePath') END AS readPath
  FROM part WHERE json_extract(data, '$.type') = 'tool' ORDER BY session_id, time_created, id`,
  texts: `SELECT message_id AS messageId, session_id AS sessionId,
  substr(json_extract(data, '$.text'), 1, ${TEXT_MAX_CHARS}) AS text
  FROM part WHERE json_extract(data, '$.type') = 'text' AND COALESCE(json_extract(data, '$.synthetic'), 0) = 0
  ORDER BY session_id, time_created, id`,
};

/**
 * OpenCode 2.x. Messages of other types (`synthetic`, `system`, `shell`,
 * `idle`, `compaction`, the switch markers) are context or bookkeeping, not
 * turns, and are skipped. Assistant messages carry no `parentID`; the
 * mapper groups them under the user message before them in `seq` order.
 */
const V2 = {
  sessions: `SELECT s.id AS id, s.parent_id AS parentId, s.title AS title, s.directory AS directory,
  s.version AS version, s.time_created AS createdMs, s.time_updated AS updatedMs, p.worktree AS worktree
  FROM session_v2 s LEFT JOIN project p ON p.id = s.project_id`,
  messages: `SELECT id, session_id AS sessionId, time_created AS createdMs, type AS role,
  json_extract(data, '$.time.completed') AS completedMs,
  json_extract(data, '$.agent') AS agent,
  json_extract(data, '$.model.providerID') AS providerId,
  json_extract(data, '$.model.id') AS modelId,
  NULL AS parentId,
  json_extract(data, '$.tokens.input') AS input,
  json_extract(data, '$.tokens.output') AS output,
  json_extract(data, '$.tokens.reasoning') AS reasoning,
  json_extract(data, '$.tokens.cache.read') AS cacheRead,
  json_extract(data, '$.tokens.cache.write') AS cacheWrite,
  json_extract(data, '$.cost') AS cost,
  json_extract(data, '$.error.type') AS error
  FROM session_message WHERE type IN ('user', 'assistant') ORDER BY session_id, seq`,
  tools: `SELECT m.id AS messageId, m.session_id AS sessionId, m.time_created AS createdMs,
  json_extract(c.value, '$.name') AS tool,
  json_extract(c.value, '$.state.status') AS status,
  json_extract(c.value, '$.time.created') AS startMs,
  json_extract(c.value, '$.time.completed') AS endMs,
  CASE WHEN json_extract(c.value, '$.name') = 'skill' THEN json_extract(c.value, '$.state.input.id') END AS skillId,
  CASE WHEN json_extract(c.value, '$.name') = 'read' THEN json_extract(c.value, '$.state.input.filePath') END AS readPath
  FROM session_message m, json_each(m.data, '$.content') c
  WHERE m.type = 'assistant' AND json_extract(c.value, '$.type') = 'tool'
  ORDER BY m.session_id, m.seq, c.key`,
  texts: `SELECT id AS messageId, session_id AS sessionId, seq, -1 AS item,
  substr(json_extract(data, '$.text'), 1, ${TEXT_MAX_CHARS}) AS text
  FROM session_message WHERE type = 'user'
  UNION ALL
  SELECT m.id, m.session_id, m.seq, c.key,
  substr(json_extract(c.value, '$.text'), 1, ${TEXT_MAX_CHARS})
  FROM session_message m, json_each(m.data, '$.content') c
  WHERE m.type = 'assistant' AND json_extract(c.value, '$.type') = 'text'
  ORDER BY sessionId, seq, item`,
};

const HAS_V2 = `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('session_v2', 'session_message')`;
const HAS_INSTRUCTION_STATE = `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('instruction_state', 'instruction_blob')`;

/** Per session, the instruction blocks it started with and holds now; values are `instruction_blob` hashes. */
const INSTRUCTION_STATE = `SELECT session_id AS sessionId, initial_values AS initialValues, current_values AS currentValues
  FROM instruction_state`;
const INSTRUCTION_BLOB = `SELECT value FROM instruction_blob WHERE hash = ?`;
/** Nested AGENTS.md files OpenCode loaded mid-session, recorded as synthetic messages. */
const NESTED_INSTRUCTIONS = `SELECT session_id AS sessionId,
  json_extract(data, '$.metadata.instruction.paths') AS paths,
  length(json_extract(data, '$.text')) AS chars
  FROM session_message WHERE type = 'synthetic' AND json_extract(data, '$.metadata.instruction.paths') IS NOT NULL`;
/** The instruction block that lists the instruction files themselves, as JSON `[{path, content}]`. */
const INSTRUCTIONS_KEY = 'core/instructions';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** One pass over the database. Throws when the file is missing or not an OpenCode store. */
export function readOpencodeStore(dbPath: string, options: SnapshotOptions = {}): OpencodeStore {
  const snapshot = createReadonlySnapshot(dbPath, options);
  let db: Database | undefined;
  try {
    db = new Database(snapshot.dbPath, { readOnly: true, fileMustExist: true });
    const rows = (sql: string): Record<string, unknown>[] => db!.all(sql) as Record<string, unknown>[];
    const q = rows(HAS_V2)[0]?.n === 2 ? V2 : LEGACY;
    const sessions: OpencodeSessionRow[] = [];
    for (const r of rows(q.sessions)) {
      const id = str(r.id);
      if (id === undefined) {
        continue;
      }
      const createdMs = num(r.createdMs);
      sessions.push({
        id,
        createdMs,
        updatedMs: Math.max(createdMs, num(r.updatedMs)),
        ...(str(r.parentId) !== undefined ? { parentId: str(r.parentId) } : {}),
        ...(str(r.title) !== undefined ? { title: str(r.title) } : {}),
        ...(str(r.directory) !== undefined ? { directory: str(r.directory) } : {}),
        ...(str(r.worktree) !== undefined ? { worktree: str(r.worktree) } : {}),
        ...(str(r.version) !== undefined ? { version: str(r.version) } : {}),
      });
    }
    const messages: OpencodeMessageRow[] = [];
    for (const r of rows(q.messages)) {
      const id = str(r.id);
      const sessionId = str(r.sessionId);
      if (id === undefined || sessionId === undefined || (r.role !== 'user' && r.role !== 'assistant')) {
        continue;
      }
      const completedMs = optNum(r.completedMs);
      const cost = optNum(r.cost);
      messages.push({
        id,
        sessionId,
        role: r.role,
        createdMs: num(r.createdMs),
        ...(completedMs !== undefined ? { completedMs } : {}),
        ...(str(r.agent) !== undefined ? { agent: str(r.agent) } : {}),
        ...(str(r.providerId) !== undefined ? { providerId: str(r.providerId) } : {}),
        ...(str(r.modelId) !== undefined ? { modelId: str(r.modelId) } : {}),
        ...(str(r.parentId) !== undefined ? { parentId: str(r.parentId) } : {}),
        inputTokens: num(r.input),
        outputTokens: num(r.output),
        reasoningTokens: num(r.reasoning),
        cacheReadTokens: num(r.cacheRead),
        cacheWriteTokens: num(r.cacheWrite),
        ...(cost !== undefined ? { cost } : {}),
        ...(str(r.error) !== undefined ? { error: str(r.error) } : {}),
      });
    }
    const tools: OpencodeToolPart[] = [];
    for (const r of rows(q.tools)) {
      const messageId = str(r.messageId);
      const sessionId = str(r.sessionId);
      if (messageId === undefined || sessionId === undefined) {
        continue;
      }
      const endMs = optNum(r.endMs);
      const readPath = str(r.readPath);
      tools.push({
        messageId,
        sessionId,
        tool: str(r.tool) ?? 'unknown',
        ...(str(r.status) !== undefined ? { status: str(r.status) } : {}),
        startMs: num(r.startMs) || num(r.createdMs),
        ...(endMs !== undefined ? { endMs } : {}),
        ...(str(r.skillId) !== undefined ? { skillId: str(r.skillId) } : {}),
        ...(readPath !== undefined && isContextPath(readPath) ? { contextPath: readPath } : {}),
      });
    }
    const texts: OpencodeTextPart[] = [];
    for (const r of rows(q.texts)) {
      const messageId = str(r.messageId);
      const sessionId = str(r.sessionId);
      const text = str(r.text);
      if (messageId !== undefined && sessionId !== undefined && text !== undefined) {
        texts.push({ messageId, sessionId, text });
      }
    }
    const instructions =
      q === V2 && rows(HAS_INSTRUCTION_STATE)[0]?.n === 2 ? readInstructionLoads(db, rows) : [];
    return { sessions, messages, tools, texts, instructions };
  } finally {
    try {
      db?.close();
    } catch {
      // never opened
    }
    snapshot.dispose();
  }
}

/**
 * The instruction files each session loaded. Each `core/instructions` blob is
 * parsed once, and only every file's path and text length are kept. A blob or
 * row that does not parse is skipped: this feeds a diagnostic tab and must
 * never fail the session list.
 */
function readInstructionLoads(db: Database, rows: (sql: string) => Record<string, unknown>[]): OpencodeInstructionLoad[] {
  const blobs = new Map<string, { path: string; chars: number }[]>();
  const filesIn = (hash: string): { path: string; chars: number }[] => {
    let files = blobs.get(hash);
    if (files === undefined) {
      files = [];
      try {
        const value = (db.get(INSTRUCTION_BLOB, [hash]) as { value?: unknown } | undefined)?.value;
        const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : undefined;
        for (const item of Array.isArray(parsed) ? parsed : []) {
          const p = (item as { path?: unknown } | null)?.path;
          const content = (item as { content?: unknown } | null)?.content;
          if (typeof p === 'string' && p.length > 0) {
            files.push({ path: p, chars: typeof content === 'string' ? content.length : 0 });
          }
        }
      } catch {
        // An unreadable blob contributes nothing.
      }
      blobs.set(hash, files);
    }
    return files;
  };
  const out: OpencodeInstructionLoad[] = [];
  for (const r of rows(INSTRUCTION_STATE)) {
    const sessionId = str(r.sessionId);
    if (sessionId === undefined) {
      continue;
    }
    const seen = new Set<string>();
    for (const column of [r.initialValues, r.currentValues]) {
      let hash: unknown;
      try {
        hash = typeof column === 'string' ? (JSON.parse(column) as Record<string, unknown>)[INSTRUCTIONS_KEY] : undefined;
      } catch {
        hash = undefined;
      }
      if (typeof hash !== 'string') {
        continue;
      }
      for (const file of filesIn(hash)) {
        if (!seen.has(file.path)) {
          seen.add(file.path);
          out.push({ sessionId, path: file.path, ...(file.chars > 0 ? { chars: file.chars } : {}), via: 'session' });
        }
      }
    }
  }
  for (const r of rows(NESTED_INSTRUCTIONS)) {
    const sessionId = str(r.sessionId);
    if (sessionId === undefined) {
      continue;
    }
    let paths: unknown;
    try {
      paths = typeof r.paths === 'string' ? JSON.parse(r.paths) : undefined;
    } catch {
      paths = undefined;
    }
    const list = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
    // The text is one "Instructions from: <path>" block per path, so its
    // length is the file's only when it names a single one.
    const chars = list.length === 1 ? num(r.chars) : 0;
    for (const p of list) {
      out.push({ sessionId, path: p, ...(chars > 0 ? { chars } : {}), via: 'nested' });
    }
  }
  return out;
}

/**
 * Re-reads only when the database or its `-wal` moved, so a list refresh does
 * not copy the file every time. A failed read is cached against the same
 * stamp and rethrown, so a broken file is not copied on every call either.
 */
export class OpencodeStoreCache {
  private key: string | undefined;
  private value: OpencodeStore | Error | undefined;

  constructor(
    private readonly dbPath: () => string,
    private readonly options: SnapshotOptions = {},
  ) {}

  get(): OpencodeStore {
    const file = this.dbPath();
    const key = [file, stamp(file), stamp(`${file}-wal`)].join('|');
    if (key !== this.key || this.value === undefined) {
      try {
        this.value = readOpencodeStore(file, this.options);
      } catch (err) {
        this.value = err instanceof Error ? err : new Error(String(err));
      }
      this.key = key;
    }
    if (this.value instanceof Error) {
      throw this.value;
    }
    return this.value;
  }

  /** The stamp {@link get} keys on: the indexer skips an unchanged store with it. */
  stamp(): { size: number; mtimeMs: number } | undefined {
    const file = this.dbPath();
    const main = statOf(file);
    if (main === undefined) {
      return undefined;
    }
    const wal = statOf(`${file}-wal`);
    return { size: main.size + (wal?.size ?? 0), mtimeMs: Math.max(main.mtimeMs, wal?.mtimeMs ?? 0) };
  }

  clear(): void {
    this.key = undefined;
    this.value = undefined;
  }
}

function statOf(file: string): { size: number; mtimeMs: number } | undefined {
  try {
    const s = fs.statSync(file);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

function stamp(file: string): string {
  const s = statOf(file);
  return s === undefined ? '-' : `${s.size}:${s.mtimeMs}`;
}
