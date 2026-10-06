import type { Configuration } from '@agent-observability/core/src/config/configuration';
import {
  CopilotJetbrainsSource,
  type JetbrainsStoreResult,
} from '@agent-observability/core/src/copilotJetbrains/copilotJetbrainsSource';
import { buildJetbrainsSessionDetail } from '@agent-observability/core/src/copilotJetbrains/mapper';
import type { SessionRow } from '../../shared/rpc';
import type { FileState, IndexDb } from './indexDb';

/**
 * Indexes Copilot chats from JetBrains IDEs.
 *
 * Unlike the transcript sources, one file holds many sessions: each chat
 * store is a database the IDE rewrites in place. A store whose size and mtime
 * have not moved keeps its rows; one that moved is scanned again and every
 * session in it is written. Sessions in the store that cannot be read stay as
 * they were, so a locked file never empties the list.
 */
const SOURCE = 'copilot-jetbrains';
const HYDRATE_BATCH = 20;

export interface CopilotJetbrainsIndexerDeps {
  db: IndexDb;
  config: Configuration;
  onRows?: (rows: SessionRow[]) => void;
  onDiscovered?: (total: number) => void;
  source?: CopilotJetbrainsSource;
  now?: () => number;
}

export interface CopilotJetbrainsIndexResult {
  stores: number;
  discovered: number;
  hydrated: number;
  /** Stores that were locked, or held nothing the scanner recognised. */
  unreadable: number;
}

export class CopilotJetbrainsIndexer {
  private readonly now: () => number;
  private readonly source: CopilotJetbrainsSource;

  constructor(private readonly deps: CopilotJetbrainsIndexerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.source = deps.source ?? new CopilotJetbrainsSource(deps.config);
  }

  run(): CopilotJetbrainsIndexResult {
    if (!this.source.isEnabled()) {
      return { stores: 0, discovered: 0, hydrated: 0, unreadable: 0 };
    }
    const excluded = this.deps.config.getExcludedRepositories();
    const stores = this.source.stores();
    const present = new Set<string>();
    let hydrated = 0;
    let unreadable = 0;
    let batch: SessionRow[] = [];
    const flush = (): void => {
      if (batch.length > 0) {
        this.deps.db.upsertSessions(batch);
        this.deps.onRows?.(batch);
        batch = [];
      }
    };

    for (const store of stores) {
      const state = this.deps.db.getFileState(store.path);
      const unchanged = state !== undefined && state.size === store.size && state.mtimeMs === store.mtimeMs;
      const kept = unchanged ? this.keptIds(state.accState) : undefined;
      if (kept !== undefined && kept.every((id) => this.deps.db.getRow(SOURCE, id) !== undefined)) {
        kept.forEach((id) => present.add(id));
        continue;
      }
      const result = this.source.load(store);
      if (result.problem === 'locked') {
        // Leave whatever an earlier pass wrote for this store in place.
        unreadable += 1;
        this.keptIds(state?.accState)?.forEach((id) => present.add(id));
        continue;
      }
      if (result.problem === 'unrecognised') {
        unreadable += 1;
      }
      const ids = this.writeStore(result, excluded, present, (row) => {
        batch.push(row);
        hydrated += 1;
        if (batch.length >= HYDRATE_BATCH) {
          flush();
        }
      });
      // The file row is written last, carrying the ids it produced, so an
      // unchanged store can be skipped on the next pass.
      flush();
      this.deps.db.putFileState(this.fileState(result, ids));
    }
    flush();
    this.deps.onDiscovered?.(present.size);
    this.deps.db.removeMissing(SOURCE, present);
    return { stores: stores.length, discovered: present.size, hydrated, unreadable };
  }

  private writeStore(
    result: JetbrainsStoreResult,
    excluded: ReadonlySet<string>,
    present: Set<string>,
    push: (row: SessionRow) => void,
  ): string[] {
    const ids: string[] = [];
    for (const input of result.sessions) {
      if (present.has(input.sessionId) || excluded.has(input.repository)) {
        continue;
      }
      present.add(input.sessionId);
      ids.push(input.sessionId);
      const summary = buildJetbrainsSessionDetail(input).summary;
      const row: SessionRow & { mainPath: string } = {
        source: SOURCE,
        sessionId: summary.sessionId,
        repository: summary.repository,
        ...(summary.title !== undefined ? { title: summary.title, titleDerived: summary.titleDerived === true } : {}),
        startedAtMs: summary.startedAtMs || result.store.mtimeMs,
        endedAtMs: summary.endedAtMs || result.store.mtimeMs,
        durationMs: summary.durationMs,
        interactionCount: summary.interactionCount,
        llmCalls: summary.llmCalls,
        toolCalls: summary.toolCalls,
        inputTokens: 0,
        outputTokens: 0,
        cachedTokens: 0,
        model: summary.model,
        agentModes: [...summary.agentModes],
        indexedAtMs: this.now(),
        pending: false,
        mainPath: result.store.path,
      };
      push(row);
    }
    return ids;
  }

  private fileState(result: JetbrainsStoreResult, ids: string[]): FileState {
    return {
      path: result.store.path,
      source: SOURCE,
      sessionId: null,
      kind: 'store',
      size: result.store.size,
      mtimeMs: result.store.mtimeMs,
      headHash: null,
      parsedBytes: result.store.size,
      accState: JSON.stringify({ ids }),
    };
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
