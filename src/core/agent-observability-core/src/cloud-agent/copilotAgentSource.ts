/**
 * The **Copilot (Autonomous)** `SessionDataSource`: surfaces the OTLP an
 * autonomous Copilot CLI agent pushed to the cloud (pulled into the local sink by
 * {@link ./agentPuller.AgentPuller}) through the SAME read stack as local Copilot
 * Chat.
 *
 * Because an autonomous agent emits the identical `gen_ai.*` OTel schema, this
 * source is a thin wrapper over a DEDICATED {@link TelemetryService} bound to the
 * sink's `ingest.db` — not a bespoke mapper like the Copilot (Cloud) source. The
 * service is pointed at the sink DB via {@link TelemetryService.setIngestDbPath}
 * and constructed with:
 *   - a config ADAPTER mapping `isLocalTelemetryEnabled()` → `isCopilotAgentEnabled()`
 *     (so the shared `withDatabases` gate follows THIS source's flag), and
 *   - a {@link PathEnvironment} that resolves NO native Copilot DB, so before the
 *     first batch lands the source shows "no data" instead of leaking the local
 *     Copilot database under this node.
 *
 * Privacy: the sink holds FULL agent telemetry (prompts, tool I/O) BY DESIGN for
 * this source — it originated in the cloud relay and is pulled LOCAL-only.
 * {@link getAggregationRows} returns `[]` so nothing is ever re-uploaded (the
 * scoped exception documented in the plan); LOCAL-only content lookups
 * ({@link getSessionContent}, {@link getContextAnalysis}) stay enabled so the
 * detail / context / deviation panels light up.
 */

import type { AggregationRow } from '../aggregate/aggregator';
import type { AcceptedMissingConfig } from '../context/contextAnalyzer';
import { analyzeContext } from '../context/contextAnalyzer';
import type { SessionContextAnalysis } from '../context/models';
import type { SessionDataSource } from '../sources/sessionSource';
import { PathEnvironment } from '../telemetry/paths';
import { ServiceConfig, TelemetryService } from '../telemetry/telemetryService';
import type { Result } from '../telemetry/telemetryService';
import type {
  AgentSourceId,
  CostMode,
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionDetail,
  SessionSummary,
} from '../telemetry/models';
import { AgentSink } from './agentSink';

const NO_EXCLUSIONS: ReadonlySet<string> = new Set();

/**
 * Config surface the source reads (satisfied by `Configuration`). The read stack
 * needs the code/doc extension lists for its LoC/LoD classification and the
 * exclusion set; the flag gates the whole source.
 */
export interface AgentSourceConfig {
  isCopilotAgentEnabled(): boolean;
  getCodeFileExtensions(): string[];
  getDocFileExtensions(): string[];
  getExcludedRepositories?(): ReadonlySet<string>;
}

/**
 * A {@link PathEnvironment} that resolves NO native database, so the dedicated
 * service reads ONLY the ingest DB we point it at (never the local Copilot DB).
 * Mirrors the `noCopilotEnv` idiom in the ingest-source tests.
 */
const NO_NATIVE_DB_ENV: PathEnvironment = {
  platform: process.platform,
  env: {},
  homedir: () => '',
  statKind: () => 'absent',
};

export class CopilotAgentSource implements SessionDataSource {
  readonly id: AgentSourceId = 'copilot-agent';
  readonly label = 'Copilot (Autonomous)';
  readonly costMode: CostMode = 'aiu';
  readonly iconId = 'server-process';

  private readonly telemetry: TelemetryService;

  constructor(
    private readonly sink: AgentSink | undefined,
    private readonly config: AgentSourceConfig,
  ) {
    this.telemetry = new TelemetryService(this.toServiceConfig(config), NO_NATIVE_DB_ENV);
    if (sink !== undefined) {
      // The sink's ingest DB is the SOLE source for this service. Recorded even
      // when the file does not exist yet — reads resolve it once the first batch
      // lands and the source is refreshed.
      this.telemetry.setIngestDbPath(sink.ingestDbPath());
    }
  }

  isEnabled(): boolean {
    return this.config.isCopilotAgentEnabled();
  }

  getOverview(sinceMs?: number): Result<OverviewMetrics> {
    return this.telemetry.getOverview(sinceMs);
  }
  listRepositories(): Result<RepositorySummary[]> {
    return this.telemetry.listRepositories();
  }
  listSessions(repository?: string, limit?: number): Result<SessionSummary[]> {
    return this.telemetry.listSessions(repository, limit);
  }
  getSessionDetail(sessionKey: string): Result<SessionDetail> {
    return this.telemetry.getSessionDetail(sessionKey);
  }
  getSessionInteractions(sessionKey: string): Result<Interaction[]> {
    return this.telemetry.getSessionInteractions(sessionKey);
  }
  getSessionContent(sessionKey: string, attribute: string): Result<ReadonlyMap<string, string>> {
    return this.telemetry.getSpanAttributes(sessionKey, attribute);
  }

  /**
   * LOCAL-ONLY through v1 — nothing is uploaded. The content ORIGINATES in the
   * cloud relay and is pulled to the local sink; re-uploading it would violate the
   * aggregate path's raw-never-leaves invariant. `[]` is safe end-to-end (the
   * composite treats it as ok; buildBatch produces an empty heartbeat).
   */
  getAggregationRows(): Result<AggregationRow[]> {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled', message: 'Copilot (Autonomous) capture is disabled.' };
    }
    return { ok: true, value: [] };
  }

  getContextAnalysis(
    sessionKey: string,
    acceptedMissing: AcceptedMissingConfig,
  ): SessionContextAnalysis | undefined {
    // Prefer the friendly subagent names the detail resolved so the Context and
    // Overview tabs label agents identically; fall back to the analyzer's own
    // DB-derived names when the detail can't be loaded.
    const detail = this.telemetry.getSessionDetail(sessionKey);
    const subagentNamesList = detail.ok
      ? [...new Set(detail.value.agentUsage.filter((u) => u.kind === 'subagent').map((u) => u.agentName))]
      : undefined;
    return analyzeContext(sessionKey, this.telemetry, acceptedMissing, undefined, subagentNamesList);
  }

  /** A note while the first batch has not been pulled yet, so an empty node explains itself. */
  truncationNote(): string | undefined {
    if (!this.isEnabled() || this.sink === undefined) {
      return undefined;
    }
    const index = this.sink.readIndex();
    if (!index.puller.firstPullCompleted && Object.keys(index.batches).length === 0) {
      return 'First pull in progress — autonomous agent sessions will appear shortly.';
    }
    return undefined;
  }

  refresh(): void {
    this.telemetry.refresh();
  }
  dispose(): void {
    this.telemetry.dispose();
  }

  /** Map this source's config onto the shared {@link ServiceConfig} the read stack needs. */
  private toServiceConfig(config: AgentSourceConfig): ServiceConfig {
    return {
      // The shared read gate follows THIS source's flag, not the local one.
      isLocalTelemetryEnabled: () => config.isCopilotAgentEnabled(),
      // Never auto-detect / override a path — the ingest DB is set explicitly.
      getSqlitePathOverride: () => undefined,
      getCodeFileExtensions: () => config.getCodeFileExtensions(),
      getDocFileExtensions: () => config.getDocFileExtensions(),
      getExcludedRepositories: () => config.getExcludedRepositories?.() ?? NO_EXCLUSIONS,
    };
  }
}
