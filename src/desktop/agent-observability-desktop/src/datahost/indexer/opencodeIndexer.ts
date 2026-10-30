import type { Configuration } from '@agent-observability/core/src/config/configuration';
import { buildOpencodeSessionDetail } from '@agent-observability/core/src/opencode/mapper';
import { OpencodeSource } from '@agent-observability/core/src/opencode/opencodeSource';
import type { SessionRow } from '../../shared/rpc';
import type { FileState, IndexDb } from './indexDb';

/**
 * Indexes OpenCode sessions.
 *
 * All of them live in one database, so like the JetBrains stores the file is
 * the unit: while its size and mtime (with its `-wal`) have not moved, the
 * rows stay; once it moves, every session is written again. A file that
 * cannot be read leaves the earlier rows in place rather than emptying the
 * list.
 *
 * The file row also records which reader produced it. An unchanged file is
 * skipped only when that reader is the current one, so a release that reads
 * the store differently re-reads it at once instead of waiting for OpenCode
 * to write again. (2.4.1 read only the 1.x tables, and its two-session result
 * stuck on any machine where OpenCode had not run since.)
 */
const SOURCE = 'opencode';
const HYDRATE_BATCH = 20;
/**
 * Bump whenever the reader or mapper changes what a store yields. A bump also
 * re-stamps every OpenCode row, which marks its analysis stale, so a change
 * to the context analysis reaches Context Hotspots without OpenCode writing.
 * 2: the 2.x tables. 3: instruction files and skills for Context Analysis.
 * 4: Copilot AI credits and per-agent run time.
 */
export const OPENCODE_READER_VERSION = 4;

export interface OpencodeIndexerDeps {
  db: IndexDb;
  config: Configuration;
  onRows?: (rows: SessionRow[]) => void;
  onDiscovered?: (total: number) => void;
  source?: OpencodeSource;
  now?: () => number;
}

export interface OpencodeIndexResult {
  discovered: number;
  hydrated: number;
  /** Set when the database exists but could not be read. */
  problem?: string;
}

export class OpencodeIndexer {
  private readonly now: () => number;
  private readonly source: OpencodeSource;

  constructor(private readonly deps: OpencodeIndexerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.source = deps.source ?? new OpencodeSource(deps.config);
  }

  run(): OpencodeIndexResult {
    if (!this.source.isEnabled()) {
      return { discovered: 0, hydrated: 0 };
    }
    const dbPath = this.source.dbPath();
    const stamp = this.source.stamp();
    if (stamp === undefined) {
      this.deps.onDiscovered?.(0);
      this.deps.db.removeMissing(SOURCE, new Set());
      return { discovered: 0, hydrated: 0 };
    }
    const state = this.deps.db.getFileState(dbPath);
    const kept = this.keptIds(state?.accState);
    const unchanged =
      state !== undefined &&
      state.size === stamp.size &&
      state.mtimeMs === stamp.mtimeMs &&
      this.readerOf(state.accState) === OPENCODE_READER_VERSION;
    if (unchanged && kept !== undefined && kept.every((id) => this.deps.db.getRow(SOURCE, id) !== undefined)) {
      this.deps.onDiscovered?.(kept.length);
      this.deps.db.removeMissing(SOURCE, new Set(kept));
      return { discovered: kept.length, hydrated: 0 };
    }
    let sessions;
    try {
      sessions = this.source.sessions();
    } catch (err) {
      // Leave whatever an earlier pass wrote in place.
      this.deps.onDiscovered?.(kept?.length ?? 0);
      return { discovered: kept?.length ?? 0, hydrated: 0, problem: err instanceof Error ? err.message : String(err) };
    }
    const ids: string[] = [];
    let batch: SessionRow[] = [];
    const flush = (): void => {
      if (batch.length > 0) {
        this.deps.db.upsertSessions(batch);
        this.deps.onRows?.(batch);
        batch = [];
      }
    };
    for (const input of sessions) {
      const summary = buildOpencodeSessionDetail(input).summary;
      ids.push(summary.sessionId);
      const row: SessionRow & { mainPath: string } = {
        source: SOURCE,
        sessionId: summary.sessionId,
        repository: summary.repository,
        ...(summary.title !== undefined ? { title: summary.title, titleDerived: summary.titleDerived === true } : {}),
        startedAtMs: summary.startedAtMs,
        endedAtMs: summary.endedAtMs,
        durationMs: summary.durationMs,
        interactionCount: summary.interactionCount,
        llmCalls: summary.llmCalls,
        toolCalls: summary.toolCalls,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cachedTokens: summary.cachedTokens,
        costMicros: summary.costMicros,
        model: summary.model,
        agentModes: [...summary.agentModes],
        indexedAtMs: this.now(),
        pending: false,
        mainPath: dbPath,
      };
      batch.push(row);
      if (batch.length >= HYDRATE_BATCH) {
        flush();
      }
    }
    flush();
    // The file row is written last, carrying the ids it produced, so an
    // unchanged database can be skipped on the next pass.
    this.deps.db.putFileState(this.fileState(dbPath, stamp, ids));
    this.deps.onDiscovered?.(ids.length);
    this.deps.db.removeMissing(SOURCE, new Set(ids));
    return { discovered: ids.length, hydrated: ids.length };
  }

  private fileState(dbPath: string, stamp: { size: number; mtimeMs: number }, ids: string[]): FileState {
    return {
      path: dbPath,
      source: SOURCE,
      sessionId: null,
      kind: 'store',
      size: stamp.size,
      mtimeMs: stamp.mtimeMs,
      headHash: null,
      parsedBytes: stamp.size,
      accState: JSON.stringify({ ids, reader: OPENCODE_READER_VERSION }),
    };
  }

  /** The reader version a file row was written by; absent before 2.4.3. */
  private readerOf(accState: string | null | undefined): number | undefined {
    if (accState === null || accState === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(accState) as { reader?: unknown };
      return typeof parsed.reader === 'number' ? parsed.reader : undefined;
    } catch {
      return undefined;
    }
  }

  private keptIds(accState: string | null | undefined): string[] | undefined {
    if (accState === null || accState === undefined) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(accState) as { ids?: unknown };
      return Array.isArray(parsed.ids) ? parsed.ids.filter((id): id is string => typeof id === 'string') : undefined;
    } catch {
      return undefined;
    }
  }
}
