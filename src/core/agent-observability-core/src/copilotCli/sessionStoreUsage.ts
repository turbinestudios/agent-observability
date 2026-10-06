import * as fs from 'node:fs';
import * as path from 'node:path';
import { Database } from 'node-sqlite3-wasm';
import { createReadonlySnapshot, type SnapshotOptions } from '../telemetry/snapshot';

/**
 * Per-call token usage from the Copilot runtime's own `session-store.db`
 * (`<copilot home>/session-store.db`, table `assistant_usage_events`).
 *
 * Why it is needed: sessions from the GitHub Copilot app, and CLI sessions
 * killed before their `session.shutdown`, carry no token totals in
 * `events.jsonl`; only this table has them. Probed against app 1.1.24 and
 * CLI 1.0.82 (October 2026): `input_tokens` already includes cache reads,
 * matching the shutdown event's `inputTokens`, so the two agree for a
 * session that has both.
 *
 * Read-only by rule. The runtime keeps the file in WAL mode with nearly all
 * data still in `-wal`, and the bundled driver cannot open WAL files, so it is
 * read through the same snapshot copy as every other SQLite store. Only
 * numeric columns and the model id are selected: never `turns`,
 * `forge_trajectory_events`, `search_index`, or `token_details_json`.
 */

export interface StoreModelUsage {
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens: number;
  aiuNano: number;
}

/** Session id → model → usage. */
export type StoreUsage = ReadonlyMap<string, ReadonlyMap<string, StoreModelUsage>>;

export function sessionStorePath(copilotHomeDir: string): string {
  return path.join(copilotHomeDir, 'session-store.db');
}

const QUERY = `SELECT session_id AS sessionId, model,
  COUNT(*) AS calls,
  SUM(COALESCE(input_tokens, 0)) AS input,
  SUM(COALESCE(output_tokens, 0)) AS output,
  SUM(COALESCE(cache_read_tokens, 0)) AS cacheRead,
  SUM(COALESCE(reasoning_tokens, 0)) AS reasoning,
  SUM(COALESCE(total_nano_aiu, 0)) AS aiu
  FROM assistant_usage_events GROUP BY session_id, model`;

const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);

/** One pass over the whole table. An absent or unexpected store reads as empty. */
export function readSessionStoreUsage(dbPath: string, options: SnapshotOptions = {}): StoreUsage {
  const out = new Map<string, Map<string, StoreModelUsage>>();
  if (!fs.existsSync(dbPath)) {
    return out;
  }
  let snapshot;
  try {
    snapshot = createReadonlySnapshot(dbPath, options);
  } catch {
    return out;
  }
  let db: Database | undefined;
  try {
    db = new Database(snapshot.dbPath, { readOnly: true, fileMustExist: true });
    for (const row of db.all(QUERY) as Record<string, unknown>[]) {
      const sessionId = typeof row.sessionId === 'string' ? row.sessionId : undefined;
      if (sessionId === undefined) {
        continue;
      }
      const model = typeof row.model === 'string' && row.model.length > 0 ? row.model : 'unknown';
      const byModel = out.get(sessionId) ?? new Map<string, StoreModelUsage>();
      byModel.set(model, {
        llmCalls: n(row.calls),
        inputTokens: n(row.input),
        outputTokens: n(row.output),
        cachedTokens: n(row.cacheRead),
        reasoningTokens: n(row.reasoning),
        aiuNano: n(row.aiu),
      });
      out.set(sessionId, byModel);
    }
  } catch {
    out.clear();
  } finally {
    try {
      db?.close();
    } catch {
      // never opened
    }
    snapshot.dispose();
  }
  return out;
}

/**
 * Re-reads only when the store or its `-wal` moved, so a list refresh does
 * not copy the database every time.
 */
export class SessionStoreUsageCache {
  private key: string | undefined;
  private value: StoreUsage = new Map();

  constructor(
    private readonly dbPath: () => string,
    private readonly options: SnapshotOptions = {},
  ) {}

  get(): StoreUsage {
    const file = this.dbPath();
    const key = [file, stamp(file), stamp(`${file}-wal`)].join('|');
    if (key !== this.key) {
      this.value = readSessionStoreUsage(file, this.options);
      this.key = key;
    }
    return this.value;
  }
}

function stamp(file: string): string {
  try {
    const s = fs.statSync(file);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return '-';
  }
}
