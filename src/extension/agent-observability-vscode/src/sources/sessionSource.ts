import type { Configuration } from '../config/configuration';
import type { Result } from '../telemetry/telemetryService';
import type { TelemetryService } from '../telemetry/telemetryService';
import type { AggregationRow } from '../aggregate/aggregator';
import type {
  AgentSourceId,
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionDetail,
  SessionSummary,
} from '../telemetry/models';

/**
 * A pluggable agent-telemetry source feeding the unified views.
 *
 * Both the Copilot path (local SQLite `agent-traces.db`) and the Claude Code path
 * (JSONL transcripts under `~/.claude/projects`) implement this single surface,
 * returning the SAME model shapes (`../telemetry/models.ts`). The Sessions tree
 * groups sources at its top level (source → repository → session); the Overview
 * merges across sources; the sync engine concatenates each source's aggregation
 * rows. Keeping the contract minimal (the methods the views + sync actually call)
 * means a new source is one class, not a view rewrite.
 *
 * Every method returns the same typed {@link Result} the Copilot
 * {@link TelemetryService} uses, so failures render as a single explanatory row
 * rather than throwing into the tree UI.
 */
export interface SessionDataSource {
  /** Stable source id (`copilot` | `claude`) — the Sessions tree groups by it. */
  readonly id: AgentSourceId;
  /** Human-readable label for the source node (e.g. `Copilot`, `Claude Code`). */
  readonly label: string;
  /** Whether this source is enabled (its feature flag is on). */
  isEnabled(): boolean;

  getOverview(sinceMs?: number): Result<OverviewMetrics>;
  listRepositories(): Result<RepositorySummary[]>;
  listSessions(repository?: string, limit?: number): Result<SessionSummary[]>;
  getSessionDetail(sessionKey: string): Result<SessionDetail>;
  getSessionInteractions(sessionKey: string): Result<Interaction[]>;
  getAggregationRows(sinceMs?: number, untilMs?: number): Result<AggregationRow[]>;

  /**
   * Optional LOCAL-ONLY content lookup for the per-turn deviation detector's
   * content predicates: span id → raw value of `attribute` for this session.
   * `attribute` is one of `CONTENT_PREDICATE_ATTRIBUTES`. An unsupported
   * attribute — or a source that captures no content — returns an empty map,
   * leaving content predicates inert. The matched text is never synced.
   */
  getSessionContent?(sessionKey: string, attribute: string): Result<ReadonlyMap<string, string>>;

  /** Drop cached state so the next query re-reads from disk. */
  refresh(): void;
  /** Release any held resources (snapshots, connections, caches). */
  dispose(): void;

  /**
   * Optional human-readable notice when the source bounded the surfaced session
   * set (e.g. Claude caps the most-recent N for responsiveness). `undefined` when
   * nothing was hidden. Surfaced as an info row so the cap is never silent.
   */
  truncationNote?(): string | undefined;
}

/**
 * Adapts the Copilot {@link TelemetryService} to {@link SessionDataSource}. The
 * service already exposes every method; this only adds the source identity and
 * the feature-flag-backed {@link isEnabled}. The Copilot detail/context/deviation
 * extras (span attributes, discovery events) stay on the concrete service, which
 * the detail panel still holds directly for Copilot sessions.
 */
export class CopilotSource implements SessionDataSource {
  readonly id: AgentSourceId = 'copilot';
  readonly label = 'Copilot';

  constructor(
    private readonly telemetry: TelemetryService,
    private readonly config: Pick<Configuration, 'isLocalTelemetryEnabled'>,
  ) {}

  isEnabled(): boolean {
    return this.config.isLocalTelemetryEnabled();
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
  getAggregationRows(sinceMs?: number, untilMs?: number): Result<AggregationRow[]> {
    return this.telemetry.getAggregationRows(sinceMs, untilMs);
  }
  refresh(): void {
    this.telemetry.refresh();
  }
  dispose(): void {
    this.telemetry.dispose();
  }
}

/**
 * Registry of the active sources in display order. The views iterate it to render
 * per-source nodes; the panel/commands resolve a source by id to route a session.
 */
export class SourceRegistry {
  private readonly byId = new Map<AgentSourceId, SessionDataSource>();
  private readonly ordered: SessionDataSource[] = [];

  constructor(sources: SessionDataSource[]) {
    for (const source of sources) {
      this.byId.set(source.id, source);
      this.ordered.push(source);
    }
  }

  /** All registered sources, in display order. */
  all(): readonly SessionDataSource[] {
    return this.ordered;
  }

  /** Only the sources whose feature flag is currently on. */
  enabled(): SessionDataSource[] {
    return this.ordered.filter((s) => s.isEnabled());
  }

  /** Resolve a source by id, or `undefined`. */
  get(id: string): SessionDataSource | undefined {
    return this.byId.get(id as AgentSourceId);
  }

  refresh(): void {
    for (const source of this.ordered) {
      source.refresh();
    }
  }

  dispose(): void {
    for (const source of this.ordered) {
      source.dispose();
    }
  }
}
