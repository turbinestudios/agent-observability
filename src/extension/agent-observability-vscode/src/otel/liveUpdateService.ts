import * as path from 'node:path';
import { Configuration } from '../config/configuration';
import { SessionDetailPanelManager } from '../views/sessionDetailPanel';
import { OtelFileTailer } from './otelFileTailer';
import { LiveSessionAggregator } from './liveSessionState';
import { extractLiveFields, parseLine } from './otlpParse';

/**
 * Default location for the Copilot OTel JSON-lines file when the user has not
 * pinned one. Kept under the extension's global storage so it is per-machine,
 * stable across windows, and out of any workspace.
 */
export function defaultOtelFilePath(globalStorageDir: string): string {
  return path.join(globalStorageDir, 'copilot-otel.jsonl');
}

/**
 * Near-real-time bridge: tails Copilot's OTel file-exporter output, folds the
 * spans into per-session running aggregates, and pushes a live status snapshot
 * to any OPEN session-detail panel whose key matches the session.
 *
 * This complements — it does not replace — the SQLite read path: the detail
 * body stays SQLite-rendered (durable history), while this overlays a live
 * banner that updates as Copilot streams spans, with no WAL/checkpoint lag.
 *
 * Off unless `agentObservability.liveUpdates.enabled` is set (the enable command
 * also configures Copilot's `github.copilot.chat.otel.*` settings + the file
 * path). Constructed once at activation; {@link restart} on config change.
 */
export class LiveUpdateService {
  private tailer: OtelFileTailer | undefined;
  private readonly aggregator = new LiveSessionAggregator();

  constructor(
    private readonly config: Configuration,
    private readonly panels: SessionDetailPanelManager,
    private readonly globalStorageDir: string,
  ) {}

  start(): void {
    if (this.tailer !== undefined || !this.config.isLiveUpdatesEnabled()) {
      return;
    }
    const filePath = this.config.getLiveOtelFilePath() ?? defaultOtelFilePath(this.globalStorageDir);
    this.tailer = new OtelFileTailer({
      filePath,
      debounceMs: this.config.getLiveDebounceMs(),
      onLines: (lines) => this.ingest(lines),
    });
    this.tailer.start();
  }

  /** Re-read config and rebuild the tailer (path/enabled/debounce may have changed). */
  restart(): void {
    this.stop();
    this.start();
  }

  private ingest(lines: string[]): void {
    const touched = new Set<string>();
    for (const line of lines) {
      for (const flat of parseLine(line)) {
        const key = this.aggregator.apply(extractLiveFields(flat));
        if (key !== undefined) {
          touched.add(key);
        }
      }
    }
    for (const key of touched) {
      const state = this.aggregator.get(key);
      if (state === undefined) {
        continue;
      }
      const payload = this.aggregator.toPayload(state);
      this.panels.pushLiveUpdate(payload.candidateIds, payload);
    }
  }

  stop(): void {
    this.tailer?.dispose();
    this.tailer = undefined;
  }

  dispose(): void {
    this.stop();
  }
}
