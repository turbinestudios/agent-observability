import * as fs from 'node:fs';
import { Database } from 'node-sqlite3-wasm';
import { createReadonlySnapshot, type SnapshotOptions } from '../telemetry/snapshot';

/**
 * Reads OpenCode's `opencode.db` (see `./paths.ts`) into plain rows.
 *
 * OpenCode keeps the file in WAL mode, so it is read through the same
 * private snapshot copy as every other SQLite store; the original is never
 * opened. Only the `session`, `message`, `part` and `project` tables are
 * queried, and from the JSON `data` columns only the fields named below:
 * never tool input or output, never reasoning text, never the `account`,
 * `credential` or `control_account` tables.
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
}

/** Caps one text part held in memory; a pasted log can run to megabytes. */
const TEXT_MAX_CHARS = 20_000;

const SESSIONS = `SELECT s.id AS id, s.parent_id AS parentId, s.title AS title, s.directory AS directory,
  s.version AS version, s.time_created AS createdMs, s.time_updated AS updatedMs, p.worktree AS worktree
  FROM session s LEFT JOIN project p ON p.id = s.project_id`;

const MESSAGES = `SELECT id, session_id AS sessionId, time_created AS createdMs,
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
  FROM message ORDER BY session_id, time_created, id`;

const TOOLS = `SELECT message_id AS messageId, session_id AS sessionId, time_created AS createdMs,
  json_extract(data, '$.tool') AS tool,
  json_extract(data, '$.state.status') AS status,
  json_extract(data, '$.state.time.start') AS startMs,
  json_extract(data, '$.state.time.end') AS endMs
  FROM part WHERE json_extract(data, '$.type') = 'tool' ORDER BY session_id, time_created, id`;

const TEXTS = `SELECT message_id AS messageId, session_id AS sessionId,
  substr(json_extract(data, '$.text'), 1, ${TEXT_MAX_CHARS}) AS text
  FROM part WHERE json_extract(data, '$.type') = 'text' AND COALESCE(json_extract(data, '$.synthetic'), 0) = 0
  ORDER BY session_id, time_created, id`;

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
    const sessions: OpencodeSessionRow[] = [];
    for (const r of rows(SESSIONS)) {
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
    for (const r of rows(MESSAGES)) {
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
    for (const r of rows(TOOLS)) {
      const messageId = str(r.messageId);
      const sessionId = str(r.sessionId);
      if (messageId === undefined || sessionId === undefined) {
        continue;
      }
      const endMs = optNum(r.endMs);
      tools.push({
        messageId,
        sessionId,
        tool: str(r.tool) ?? 'unknown',
        ...(str(r.status) !== undefined ? { status: str(r.status) } : {}),
        startMs: num(r.startMs) || num(r.createdMs),
        ...(endMs !== undefined ? { endMs } : {}),
      });
    }
    const texts: OpencodeTextPart[] = [];
    for (const r of rows(TEXTS)) {
      const messageId = str(r.messageId);
      const sessionId = str(r.sessionId);
      const text = str(r.text);
      if (messageId !== undefined && sessionId !== undefined && text !== undefined) {
        texts.push({ messageId, sessionId, text });
      }
    }
    return { sessions, messages, tools, texts };
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
