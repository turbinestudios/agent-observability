/**
 * Public surface of @agent-observability/core.
 *
 * Everything here is host-independent: no `vscode`, no Electron. That is
 * enforced by the `no-restricted-imports` rule in this package's eslint config.
 *
 * This barrel covers the common entry points — the seams a host implements and
 * the services it wires together. Anything else is reachable by deep import
 * (`@agent-observability/core/src/telemetry/models`), which is also the form to
 * prefer inside large consumers so imports stay traceable.
 *
 * Re-exports are explicit rather than `export *` on purpose: several subtrees
 * define their own `models.ts`, and star-exporting them would collide silently.
 */

// ---------------------------------------------------------------------------
// Host seams — each host supplies an implementation.
// ---------------------------------------------------------------------------
export type { Logger } from './log/logger';
export { NoopLogger, errorMessage } from './log/logger';
export type { SettingsReader, SettingsSubscription } from './config/configuration';
export type { FileWatchFactory, WatchHandle } from './live/claudeWatcher';
export type { SyncStateStore, SyncRun, SyncRunOutcome } from './sync/syncState';
export { InMemorySyncStateStore, MAX_HISTORY } from './sync/syncState';
export type { HttpPoster } from './sync/httpPoster';
export { FetchHttpPoster } from './sync/httpPoster';
export type { CancellationToken, DisposableLike } from './chat/backends/cancellation';
export { NEVER_CANCELLED } from './chat/backends/cancellation';

// ---------------------------------------------------------------------------
// Configuration.
// ---------------------------------------------------------------------------
export {
  Configuration,
  CONFIG_SECTION,
  ConfigKeys,
  ConfigDefaults,
  normalizeDashboardUrl,
} from './config/configuration';

// ---------------------------------------------------------------------------
// Session sources — the central abstraction every UI reads through.
// ---------------------------------------------------------------------------
export type { SessionDataSource } from './sources/sessionSource';
export { SourceRegistry, CopilotSource } from './sources/sessionSource';
export { TelemetryService } from './telemetry/telemetryService';
export type { Result, FailureReason, ServiceConfig } from './telemetry/telemetryService';
export { ClaudeCodeService } from './claude/claudeCodeService';
export type { ClaudeServiceConfig } from './claude/claudeCodeService';
export { CopilotCloudSource } from './cloud/copilotCloudSource';
export { CopilotAgentSource } from './cloud-agent/copilotAgentSource';

// ---------------------------------------------------------------------------
// Shared data model.
// ---------------------------------------------------------------------------
export type {
  AgentSourceId,
  Interaction,
  OverviewMetrics,
  RepositorySummary,
  SessionDetail,
  SessionSummary,
  SessionTurn,
} from './telemetry/models';

// ---------------------------------------------------------------------------
// Session retrospective (local heuristic analysis — see docs/proposals/09).
// ---------------------------------------------------------------------------
export { buildSessionRetrospective, sessionCodeChurn } from './analysis/retrospective';
export type {
  SessionRetrospective,
  RetrospectiveCounts,
  RetrospectiveSignals,
  RetrospectiveFinding,
  RetrospectiveTip,
  RetrospectiveLlmVerdict,
  SessionVerdict,
  SessionOutcome,
} from './analysis/retrospective';
export { extractRetrospectiveSignals } from './claude/retrospectiveSignals';

// ---------------------------------------------------------------------------
// Live updates.
// ---------------------------------------------------------------------------
export { LiveUpdateController } from './live/liveUpdateController';
export { ClaudeWatcher } from './live/claudeWatcher';

// ---------------------------------------------------------------------------
// Sync (opt-in aggregate upload — always gated on consent + API key).
// ---------------------------------------------------------------------------
export { SyncEngine, systemClock } from './sync/syncEngine';
export { SyncClient } from './sync/syncClient';
export { SyncScheduler } from './sync/scheduler';
export { CompositeAggregationSource } from './sync/compositeAggregationSource';
export { computeCanSync } from './consent/syncGate';
export { buildBatch } from './aggregate/aggregator';

// ---------------------------------------------------------------------------
// Pure renderers — full HTML documents, usable in any browser context.
// ---------------------------------------------------------------------------
export {
  renderSessionDetailHtml,
  renderCombinedSessionDetailHtml,
  renderRepositoryDetailHtml,
} from './views/sessionDetailHtml';
export { escapeHtml } from './views/escapeHtml';

// ---------------------------------------------------------------------------
// AI Helper seams (the Copilot backend is VS Code-only and stays there).
// ---------------------------------------------------------------------------
export type { ChatBackend, ChatRequest, BackendId, ModelChoice } from './chat/backends/chatBackend';
export { ChatBackendRegistry } from './chat/backends/chatBackend';
export { ClaudeCodeBackend } from './chat/backends/claudeCodeBackend';
export type { WebviewToHost, HostToWebview } from './chat/webview/protocol';
export { markdownToHtml } from './chat/webview/markdownToHtml';
