import { importedDetail } from '@agent-observability/core/src/share/sharedSession';
import { SHARED_SOURCE_ID } from '@agent-observability/core/src/share/sharedSessionModels';
import type { SharedSessionSource } from '@agent-observability/core/src/share/sharedSessionSource';
import type { SessionRow } from '../../shared/rpc';
import type { IndexDb } from './indexDb';

/**
 * Lists imported shared sessions: one row per file in the app's own
 * `shared/` folder. There are few of them and each is one file, so every
 * pass re-reads the folder; a file whose size and mtime have not moved keeps
 * its row untouched (and so keeps its analysis).
 *
 * Rows are listed like any other session so they can be opened and
 * compared. Keeping them out of this user's own figures is the data host's
 * job, which excludes the `shared` source from every aggregate query.
 */
export interface SharedIndexerDeps {
  db: IndexDb;
  source: SharedSessionSource;
  onRows?: (rows: SessionRow[]) => void;
  now?: () => number;
}

export interface SharedIndexResult {
  discovered: number;
  hydrated: number;
  /** Stored files that no longer validate, named so the status bar can say so. */
  problems: string[];
}

export class SharedIndexer {
  private readonly now: () => number;

  constructor(private readonly deps: SharedIndexerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  run(): SharedIndexResult {
    const { sessions, problems } = this.deps.source.sessions();
    const ids = new Set<string>();
    const changed: SessionRow[] = [];
    for (const stored of sessions) {
      ids.add(stored.id);
      const state = this.deps.db.getFileState(stored.file);
      const unchanged =
        state !== undefined &&
        state.size === stored.size &&
        state.mtimeMs === stored.mtimeMs &&
        this.deps.db.getRow(SHARED_SOURCE_ID, stored.id) !== undefined;
      if (unchanged) {
        continue;
      }
      const summary = importedDetail(stored.envelope, stored.id).summary;
      const row: SessionRow & { mainPath: string } = {
        source: SHARED_SOURCE_ID,
        sessionId: stored.id,
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
        mainPath: stored.file,
      };
      changed.push(row);
      this.deps.db.upsertSessions([row]);
      this.deps.db.putFileState({
        path: stored.file,
        source: SHARED_SOURCE_ID,
        sessionId: stored.id,
        kind: 'shared',
        size: stored.size,
        mtimeMs: stored.mtimeMs,
        headHash: null,
        parsedBytes: stored.size,
        accState: null,
      });
    }
    if (changed.length > 0) {
      this.deps.onRows?.(changed);
    }
    this.deps.db.removeMissing(SHARED_SOURCE_ID, ids);
    return { discovered: ids.size, hydrated: changed.length, problems };
  }
}
