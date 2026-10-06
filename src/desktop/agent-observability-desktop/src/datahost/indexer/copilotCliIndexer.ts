import type { Configuration } from '@agent-observability/core/src/config/configuration';
import { CopilotCliSource } from '@agent-observability/core/src/copilotCli/copilotCliSource';
import type { CliClient } from '@agent-observability/core/src/copilotCli/events';
import { buildCliSessionDetail } from '@agent-observability/core/src/copilotCli/mapper';
import {
  defaultCopilotCliFs,
  discoverCopilotCliSessions,
  type CopilotCliFs,
} from '@agent-observability/core/src/copilotCli/paths';
import type { SessionRow } from '../../shared/rpc';
import type { FileState, IndexDb } from './indexDb';

/**
 * Indexes the Copilot runtime's sessions from `~/.copilot/session-state`,
 * once per client: the CLI (with the SDK and VS Code's wrapper) as
 * `copilot-cli`, and the GitHub Copilot app as `copilot-app`.
 *
 * Same shape as the Claude indexer: discovery is a directory listing, a
 * session is re-parsed only when its events file's size or mtime moved, and
 * rows are pushed in batches. Three things differ. Directories without an
 * events file are not sessions and never produce a row. A session another
 * client wrote is skipped before anything else, so a row an older release
 * filed under the CLI moves to the app source on the next pass. And the
 * app's own Copilot helper runs live in the same store: the source drops
 * them, and any row an earlier pass wrote for one is removed here.
 */
const HYDRATE_BATCH = 20;
/** `files.kind` for an events file known to be one of the app's own helper runs. */
const HELPER_KIND = 'helper';

export interface CopilotCliIndexerDeps {
  db: IndexDb;
  config: Configuration;
  onRows?: (rows: SessionRow[]) => void;
  onDiscovered?: (total: number) => void;
  fs?: CopilotCliFs;
  now?: () => number;
  /** Which client's sessions this pass indexes; the CLI when absent. */
  client?: CliClient;
}

export class CopilotCliIndexer {
  private readonly now: () => number;
  private readonly fs: CopilotCliFs;
  private readonly source: CopilotCliSource;

  constructor(private readonly deps: CopilotCliIndexerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.fs = deps.fs ?? defaultCopilotCliFs;
    this.source = new CopilotCliSource(deps.config, this.fs, deps.client ?? 'cli');
  }

  run(): { discovered: number; hydrated: number; helperRuns: number } {
    if (!this.source.isEnabled()) {
      return { discovered: 0, hydrated: 0, helperRuns: 0 };
    }
    const SOURCE = this.source.id;
    const excluded = this.deps.config.getExcludedRepositories();
    const discovered = discoverCopilotCliSessions(this.fs);
    const present = new Set<string>();
    let helperRuns = 0;
    let hydrated = 0;
    let batch: { row: SessionRow; file: FileState }[] = [];
    const flush = (): void => {
      if (batch.length > 0) {
        this.deps.db.upsertHydratedSessions(batch);
        this.deps.onRows?.(batch.map((entry) => entry.row));
        batch = [];
      }
    };

    for (const files of discovered) {
      if (!this.source.owns(files)) {
        continue;
      }
      const state = this.deps.db.getFileState(files.eventsFile);
      const unchanged = state !== undefined && state.size === files.size && state.mtimeMs === files.mtimeMs;
      if (unchanged && state.kind === HELPER_KIND) {
        // Already recognised as one of the app's own runs: not read again.
        helperRuns += 1;
        continue;
      }
      if (unchanged && state.source === SOURCE && this.deps.db.getRow(SOURCE, files.sessionId) !== undefined) {
        present.add(files.sessionId);
        continue;
      }
      const input = this.source.load(files);
      if (input === undefined) {
        helperRuns += 1;
        this.deps.db.putFileState({
          path: files.eventsFile,
          source: SOURCE,
          sessionId: null,
          kind: HELPER_KIND,
          size: files.size,
          mtimeMs: files.mtimeMs,
          headHash: null,
          parsedBytes: files.size,
          accState: null,
        });
        continue;
      }
      if (excluded.has(input.repository)) {
        continue;
      }
      present.add(files.sessionId);
      const summary = buildCliSessionDetail(input).summary;
      const row: SessionRow & { mainPath: string } = {
        source: SOURCE,
        sessionId: summary.sessionId,
        repository: summary.repository,
        ...(summary.title !== undefined ? { title: summary.title, titleDerived: summary.titleDerived === true } : {}),
        startedAtMs: summary.startedAtMs || files.mtimeMs,
        endedAtMs: summary.endedAtMs || files.mtimeMs,
        durationMs: summary.durationMs,
        interactionCount: summary.interactionCount,
        llmCalls: summary.llmCalls,
        toolCalls: summary.toolCalls,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        cachedTokens: summary.cachedTokens,
        ...(summary.costMicros !== undefined ? { costMicros: summary.costMicros } : {}),
        model: summary.model,
        agentModes: [...summary.agentModes],
        indexedAtMs: this.now(),
        pending: false,
        mainPath: files.eventsFile,
      };
      batch.push({
        row,
        file: {
          path: files.eventsFile,
          source: SOURCE,
          sessionId: files.sessionId,
          kind: 'main',
          size: files.size,
          mtimeMs: files.mtimeMs,
          headHash: null,
          parsedBytes: files.size,
          accState: null,
        },
      });
      hydrated += 1;
      if (batch.length >= HYDRATE_BATCH) {
        flush();
      }
    }
    flush();
    this.deps.onDiscovered?.(present.size);
    // Also drops rows for sessions that vanished and for helper runs indexed
    // before the exclusion existed.
    this.deps.db.removeMissing(SOURCE, present);
    return { discovered: present.size, hydrated, helperRuns };
  }

}

const RUNTIME_SOURCES = ['copilot-cli', 'copilot-app'] as const;

/**
 * A CLI session started from an editor can also reach the VS Code Copilot
 * source under the same id. It is one session; the runtime's row carries the
 * fuller record, so the other is dropped. Runs after all indexers.
 */
export function dropCopilotDuplicates(db: Pick<IndexDb, 'sessionKeys' | 'getRow' | 'removeSession'>): number {
  let dropped = 0;
  for (const key of db.sessionKeys()) {
    const source = RUNTIME_SOURCES.find((s) => key.startsWith(`${s}:`));
    if (source === undefined) {
      continue;
    }
    const sessionId = key.slice(source.length + 1);
    if (db.getRow('copilot', sessionId) !== undefined) {
      db.removeSession('copilot', sessionId);
      dropped += 1;
    }
  }
  return dropped;
}
