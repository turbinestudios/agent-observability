import * as vscode from 'vscode';
import * as path from 'node:path';
import * as net from 'node:net';
import { Configuration, CONFIG_SECTION, ConfigKeys } from './config/configuration';
import { RepoSyncMode } from './aggregate/repoSyncPolicy';
import { registerCommands, Refreshable } from './commands';
import { OverviewViewProvider, OVERVIEW_VIEW_ID } from './views/overviewView';
import { SessionsViewProvider, SESSIONS_VIEW_ID } from './views/sessionsView';
import { SyncViewProvider, SYNC_VIEW_ID } from './views/syncView';
import { SessionDetailPanelManager } from './views/sessionDetailPanel';
import { TelemetryService } from './telemetry/telemetryService';
import { LocalDeviationDetector } from './deviation/localDeviations';
import { ConsentManager } from './consent/consentManager';
import { SecretManager } from './secrets/secretManager';
import { buildBatch } from './aggregate/aggregator';
import { getIdentityInput, computeDeveloperId } from './aggregate/pseudonymizer';
import { FetchHttpPoster } from './sync/httpPoster';
import { SyncClient } from './sync/syncClient';
import { GlobalStateSyncStateStore } from './sync/syncState';
import { SyncEngine, SyncContextInsightsSource, SyncTelemetry, formatContextInsightsDiagnostics, systemClock } from './sync/syncEngine';
import { SyncScheduler } from './sync/scheduler';
import { registerObservabilityChatParticipant } from './chat/observabilityChat';
import { ChatViewProvider, ASSISTANT_VIEW_ID } from './chat/webview/chatViewProvider';
import { WorkflowDivergenceNotifier } from './notify/workflowDivergenceNotifier';
import { LiveOtlpService } from './otel/liveOtlpService';
import { CopilotArchiver } from './otel/copilotArchiver';
import { resolveArchiveDbPath } from './otel/archivePaths';
import { LiveUpdateController } from './live/liveUpdateController';
import { ClaudeWatcher, WatchHandle } from './live/claudeWatcher';
import { vscodeFileWatchFactory } from './live/vscodeFileWatchFactory';
import { ClaudeCodeService } from './claude/claudeCodeService';
import { GitRemoteResolver } from './claude/gitRemote';
import { resolveClaudeProjectsDirs } from './claude/paths';
import { CopilotSource, SourceRegistry } from './sources/sessionSource';
import { readWorkspaceStoreSessions } from './telemetry/workspaceStore';
import { CompositeAggregationSource } from './sync/compositeAggregationSource';
import { OutputChannelLogger } from './log/outputChannelLogger';
import { Logger } from './log/logger';

/**
 * Extension entrypoint.
 *
 * Phase 2: constructs the read-only {@link TelemetryService} (local SQLite
 * ingestion) and wires it into the three view providers. NO network call is
 * made; the real Copilot DB is never opened in place or written — the service
 * reads a disposable snapshot copy.
 *
 * Phase 4: adds consent + secret management. {@link ConsentManager} (opt-out
 * default) and {@link SecretManager} (SecretStorage-backed API key + pseudonym
 * salt) gate any upload. Toggling consent or storing/clearing the key refreshes
 * the Sync view.
 *
 * Phase 7: connects the aggregate engine to the cloud ingestion API. Constructs
 * the {@link SyncEngine} (single origin of any upload, double-gated on consent +
 * key) and the {@link SyncScheduler} (OFF by default, runs only when
 * `sync.enabled` is true). The API key and request body are NEVER logged.
 */
let sources: SourceRegistry | undefined;
let sessionDetailPanels: SessionDetailPanelManager | undefined;
let consentManager: ConsentManager | undefined;
let syncScheduler: SyncScheduler | undefined;
let liveController: LiveUpdateController | undefined;
let copilotArchiver: CopilotArchiver | undefined;

export function activate(context: vscode.ExtensionContext): void {
  // Diagnostic Output channel ("Agent Observability"). Content-free by contract
  // (counts/ids/statuses only — never prompts, completions, the API key, or the
  // pseudonym salt). Stays local; this is diagnostics, not telemetry.
  const logger = new OutputChannelLogger();
  context.subscriptions.push(logger);

  const config = new Configuration();
  const telemetry = new TelemetryService(config);

  // Source registry: the Copilot SQLite path + the Claude Code JSONL path, both
  // implementing the same SessionDataSource surface so the views/sync stay
  // source-agnostic. The Claude source reads ~/.claude/projects on demand.
  const claude = new ClaudeCodeService(config);
  const registry = new SourceRegistry([new CopilotSource(telemetry, config), claude]);
  sources = registry;

  // Consent + secret management (Phase 4). Both are constructed from the
  // extension context: consent in globalState, secrets in SecretStorage.
  const consent = new ConsentManager(context);
  consentManager = consent;
  const secrets = new SecretManager(context);

  // Local-only workflow deviation detection for the session-detail webview.
  const deviations = new LocalDeviationDetector(config);
  const detailPanels = new SessionDetailPanelManager(registry, deviations);
  sessionDetailPanels = detailPanels;

  // Proactive per-turn workflow-divergence notifications (off by default). After a
  // refresh it scans settled turns of recently-active sessions in repositories
  // with configured workflows — across EVERY enabled source (Copilot + Claude
  // Code) — and toasts NEW divergences, opening the owning source's session-detail
  // panel on click. Local-only — nothing is uploaded. The lone `vscode` call is
  // injected so the notifier itself stays source-agnostic and headless-testable.
  const divergenceNotifier = new WorkflowDivergenceNotifier(
    config,
    registry,
    deviations,
    (sourceId, sessionKey) => detailPanels.open(sourceId, sessionKey),
    (message, action) =>
      Promise.resolve(
        action === undefined
          ? vscode.window.showWarningMessage(message)
          : vscode.window.showWarningMessage(message, action),
      ),
  );

  // The real-time OTLP receiver is wired further below, once the views + notifier
  // it refreshes have been constructed.

  // Phase 7 sync wiring. The state store persists the watermark + run history;
  // the client transports batches via globalThis.fetch (vscode extension host).
  const toolVersion = readToolVersion(context);
  const syncState = new GlobalStateSyncStateStore(context.globalState);
  const syncClient = new SyncClient(
    new FetchHttpPoster(),
    () => config.getDashboardUrl(),
    () => secrets.getApiKey(),
  );
  // LOCAL-ONLY source for the secondary context-insights upload. Supplies the
  // engine with per-session discovery events and the subset of sessions the
  // on-machine deviation detector flagged. Both read local telemetry only; raw
  // content never leaves the machine (only counts/categories are aggregated).
  const contextInsightsSource: SyncContextInsightsSource = {
    getDiscoveryEvents: (sessionKey) => {
      const result = telemetry.getContextDiscoveryEvents(sessionKey);
      return result.ok ? result.value : [];
    },
    getDeviationSessionKeys: (sessionKeys) => {
      const flagged = new Set<string>();
      for (const sessionKey of sessionKeys) {
        const interactions = telemetry.getSessionInteractions(sessionKey);
        if (!interactions.ok) {
          continue;
        }
        // Detection is per user-request TURN (like the detail view and the
        // notifier), so bucket by the session's turn anchors; a session whose
        // detail cannot be read has no turn boundaries and is skipped.
        const detail = telemetry.getSessionDetail(sessionKey);
        if (!detail.ok) {
          continue;
        }
        const turnStarts = detail.value.turns.map((t) => t.timestampMs);
        // Memoized LOCAL-ONLY content lookup for content-predicate workflows;
        // the raw text is evaluated on-machine only and never transmitted.
        const attributeCache = new Map<string, ReadonlyMap<string, string>>();
        const contentLookup = (attribute: string): ReadonlyMap<string, string> => {
          let values = attributeCache.get(attribute);
          if (values === undefined) {
            const lookup = telemetry.getSpanAttributes(sessionKey, attribute);
            values = lookup.ok ? lookup.value : new Map<string, string>();
            attributeCache.set(attribute, values);
          }
          return values;
        };
        if (deviations.detectForSession(interactions.value, turnStarts, contentLookup).length > 0) {
          flagged.add(sessionKey);
        }
      }
      return flagged;
    },
  };
  // Aggregate-sync source: the UNION of every enabled source's privacy-safe
  // rows (Copilot + Claude Code), so the opt-in cloud batch covers both. Each
  // source emits the same content-free AggregationRow; rows commingle and are
  // distinguished server-side by model/repository (no schema change needed).
  const aggregationSource = new CompositeAggregationSource(() => registry.enabled());
  const syncEngine = new SyncEngine(
    config,
    consent,
    secrets,
    aggregationSource,
    syncClient,
    syncState,
    systemClock,
    {
      toolVersion,
      workspaceCwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      machineId: vscode.env.machineId,
      // Surface the otherwise-silent context-insights upload in the extension log
      // so an empty Context Hotspots page can be diagnosed (counts only, no paths).
      onContextInsights: (d) => logger.info(formatContextInsightsDiagnostics(d)),
    },
    contextInsightsSource,
  );

  // Construct the view providers. Overview + Sessions are source-aware (they
  // render every enabled source); Sync stays Copilot-backed (its status view).
  const overview = new OverviewViewProvider(registry);
  const sessions = new SessionsViewProvider(registry);
  const sync = new SyncViewProvider(config, telemetry, consent, secrets, syncState);

  // AI Helper — a Copilot-backed chat webview grounded in baked-in context files
  // and the user's LOCAL telemetry. Sends only safe metadata to the user's own
  // Copilot model (gated by a one-time disclosure); never raw content or the key.
  const assistant = new ChatViewProvider(context, telemetry, config);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ASSISTANT_VIEW_ID, assistant, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Register each provider against its contributed view id. The Sessions view
  // uses createTreeView with canSelectMany so multiple sessions can be selected
  // and combined into one detail view; the other two are simple data providers.
  context.subscriptions.push(
    vscode.window.registerTreeDataProvider(OVERVIEW_VIEW_ID, overview),
    vscode.window.createTreeView(SESSIONS_VIEW_ID, {
      treeDataProvider: sessions,
      canSelectMany: true,
    }),
    vscode.window.registerTreeDataProvider(SYNC_VIEW_ID, sync),
  );

  // ── Current-workspace chat-session context ──────────────────────────────────
  // The extension host alone knows the open folder and its workspaceStorage
  // `<hash>` directory (the parent of this extension's own storageUri). From it
  // we resolve the workspace's SANITIZED repository (its git remote) and
  // enumerate its chat sessions, so a JUST-STARTED session groups under the
  // right repo and can surface BEFORE its first telemetry span lands. All reads
  // are LOCAL; the repo is sanitized at the git-remote chokepoint and nothing is
  // uploaded.
  const gitRemote = new GitRemoteResolver();
  const workspaceHashDir =
    context.storageUri !== undefined ? path.dirname(context.storageUri.fsPath) : undefined;
  const refreshWorkspaceContext = (): void => {
    if (workspaceHashDir === undefined) {
      telemetry.setWorkspaceSessionContext(undefined);
      return;
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const repository = folder !== undefined ? gitRemote.resolve(folder) : UNKNOWN_REPOSITORY;
    const store = readWorkspaceStoreSessions(workspaceHashDir);
    telemetry.setWorkspaceSessionContext({
      repository,
      sessionIds: store.sessionIds,
      recent: store.recent,
    });
  };
  refreshWorkspaceContext();

  // Watch THIS workspace's chat-session store: a created/updated `<id>.jsonl`
  // means a chat was opened or advanced, so re-read the context and re-render the
  // session list. This is the ONE place the list refreshes on live activity — the
  // OTLP/span poll deliberately refreshes only detail panels (see `refreshLive`)
  // to avoid flickering the tree, so the store watch is what makes a new session
  // POP IN without a manual refresh. Debounced; watches a path OUTSIDE the
  // workspace (globalStorage), which vscode's file watcher supports.
  let storeWatch: WatchHandle | undefined;
  let storeDebounce: ReturnType<typeof setTimeout> | undefined;
  const onStoreChanged = (): void => {
    if (storeDebounce !== undefined) {
      clearTimeout(storeDebounce);
    }
    storeDebounce = setTimeout(() => {
      storeDebounce = undefined;
      refreshWorkspaceContext();
      sessions.refresh();
    }, 400);
  };
  if (workspaceHashDir !== undefined) {
    try {
      storeWatch = vscodeFileWatchFactory.watch(
        path.join(workspaceHashDir, 'chatSessions'),
        onStoreChanged,
      );
    } catch (err) {
      logger.error('Chat-session store watcher failed to start', err);
    }
  }
  context.subscriptions.push({
    dispose: () => {
      storeWatch?.dispose();
      if (storeDebounce !== undefined) {
        clearTimeout(storeDebounce);
      }
    },
  });

  // Refresh re-reads every source (re-snapshots Copilot, re-discovers Claude),
  // re-reads the workspace chat-session context, then fans out to every view.
  const sourcesRefresh: Refreshable = { refresh: () => registry.refresh() };
  const workspaceContextRefresh: Refreshable = { refresh: () => refreshWorkspaceContext() };
  const refreshables: Refreshable[] = [
    sourcesRefresh,
    workspaceContextRefresh,
    overview,
    sessions,
    sync,
    divergenceNotifier,
  ];

  // ── Real-time live updates ──────────────────────────────────────────────────
  // Both live sources (the Copilot OTLP receiver + the Claude transcript watcher)
  // funnel through ONE LiveUpdateController: each calls `signal()` on new activity
  // and the controller coalesces the burst into a single debounced refresh.
  const ingestDbPath = path.join(context.globalStorageUri.fsPath, 'ingest', 'agent-traces.db');

  // CHEAP, targeted invalidation (vs the heavy full registry refresh): drop the
  // Copilot snapshot so freshly-ingested OTLP rows reload, and forget the Claude
  // directory listing so only the changed transcript re-parses (its mtime-keyed
  // caches survive). A subsequent read/re-render then sees the new activity.
  const invalidateLiveSources = (): void => {
    telemetry.refresh();
    claude.invalidateDiscovery();
  };

  // LIVE poll (debounced; fires on every observed signal). Deliberately SCOPED to
  // the opened detail panel(s): the session list / overview / sync trees are NOT
  // refreshed here, so polling never flickers the list with a loading state. Those
  // trees refresh on a manual refresh, a config change, or when the receiver first
  // binds (below) — the full session list does not need to be near-real-time. The
  // divergence-notifier scan stays: it renders no tree/loading UI and is gated off
  // by default, so opt-in proactive toasts still fire in near-real-time.
  const refreshLive = (): void => {
    invalidateLiveSources();
    divergenceNotifier.refresh();
    detailPanels.rerenderActive();
  };

  // One-time render when the OTLP receiver binds and the ingest DB becomes the
  // Copilot source — refresh EVERY view once so the switch is reflected. This is a
  // setup event, not a recurring poll, so the full tree fan-out is fine here.
  const renderAllViews = (): void => {
    invalidateLiveSources();
    overview.refresh();
    sessions.refresh();
    sync.refresh();
    divergenceNotifier.refresh();
    detailPanels.rerenderActive();
  };

  const stopLive = (): void => {
    liveController?.stop();
    liveController = undefined;
  };

  // ── Durable Copilot archive ─────────────────────────────────────────────────
  // Copilot writes only a short, rolling native DB in per-edition globalStorage,
  // so its history is lost and differs between windows. The archiver continuously
  // sweeps that native DB (and the live-ingest DB) into ONE durable, home-anchored
  // archive, which the read layer then prefers — so Copilot sessions persist and
  // appear in EVERY VS Code window/edition, the way Claude Code's do. On by
  // default, independent of live updates; a single-writer lease keeps one window
  // authoritative. Everything stays local; nothing is uploaded.
  const stopArchiver = (): void => {
    copilotArchiver?.stop();
    copilotArchiver = undefined;
  };

  const startArchiver = (): void => {
    stopArchiver();
    const archiveDbPath = resolveArchiveDbPath(config);
    if (!config.isCopilotArchiveEnabled() || archiveDbPath === undefined) {
      telemetry.setArchiveDbPath(undefined);
      return;
    }
    // Prefer the archive as the read source (falls back to the native DB until the
    // first sweep creates it), then sweep and reflect the result once.
    telemetry.setArchiveDbPath(archiveDbPath);
    const archiver = new CopilotArchiver({
      archiveDbPath,
      config,
      liveIngestDbPath: ingestDbPath,
      retentionMs: config.getArchiveRetentionMs(),
      sweepIntervalMs: config.getArchiveSweepMs(),
      // A sweep that ingests new spans refreshes the same non-disruptive way the
      // live sources do (detail panels + notifier); the list picks up new sessions
      // on the next full refresh.
      signal: refreshLive,
      onError: (err) => logger.error('Copilot archive sweep error', err),
    });
    copilotArchiver = archiver;
    archiver.start(); // first sweep runs synchronously
    renderAllViews(); // reflect the freshly-populated archive once
  };

  // Build + start the live pipeline for whichever sources apply. Idempotent: a
  // re-entry (e.g. the Enable command) tears the previous one down first. Off
  // unless `liveUpdates.enabled`.
  const startLive = (): void => {
    stopLive();
    if (!config.isLiveUpdatesEnabled()) {
      return;
    }
    const controller = new LiveUpdateController({
      onRefresh: refreshLive,
      debounceMs: config.getLiveDebounceMs(),
      onError: (err) => logger.error('Live update pipeline error', err),
    });

    // Copilot: localhost OTLP receiver. Copilot must be pointed here via "Enable
    // Live Updates", which also needs a FULL VS Code restart for Copilot to switch
    // exporters; the receiver itself is harmless to run before that. The port is a
    // USER setting shared by every VS Code window, so only ONE window can own the
    // receiver: the winner binds and writes the shared ingest DB; every other
    // window follows it as a READER of its `/events` stream and races to take the
    // port over when the receiver's window closes.
    controller.register(
      new LiveOtlpService({
        ingestDbPath,
        port: config.getLiveOtelPort(),
        signal: () => controller.signal(),
        onListening: (boundPort) => {
          // The ingest DB now exists → make it the sole Copilot source, then render
          // every view ONCE (one-time setup, not a poll — safe to refresh the trees).
          telemetry.setIngestDbPath(ingestDbPath);
          logger.info(`Live OTLP receiver listening on 127.0.0.1:${boundPort}.`);
          renderAllViews();
        },
        onReading: () => {
          // Reader window: the same shared ingest DB (written by the receiver's
          // window) becomes the Copilot source; the receiver's pushes arrive as
          // `signal()` calls through the event stream.
          telemetry.setIngestDbPath(ingestDbPath);
          logger.info(
            'Another VS Code window owns the live OTLP receiver on ' +
              `127.0.0.1:${config.getLiveOtelPort()} — following it for live updates.`,
          );
          renderAllViews();
        },
        // NOT fired when a sibling window owns the port (that is the reader
        // path above) — only for real conflicts, where a fresh port helps.
        onStartError: (err) => {
          logger.error('Could not start the live OTLP receiver', err);
          void vscode.window.showErrorMessage(
            'Agent Observability: could not start the real-time OTLP receiver on port ' +
              `${config.getLiveOtelPort()}. Re-run “Enable Live Updates” to pick a fresh port.`,
          );
        },
        onError: (err) => logger.error('Live OTLP pipeline error', err),
      }),
    );

    // Claude Code: transcript file watcher. No exporter config and NO restart —
    // the JSONL files are always being written, so watching them is the signal.
    if (claude.isEnabled()) {
      controller.register(
        new ClaudeWatcher({
          resolveDirs: () => resolveClaudeProjectsDirs(config),
          factory: vscodeFileWatchFactory,
          signal: () => controller.signal(),
          onWatching: (dirs) => {
            logger.info(
              dirs.length > 0
                ? `Watching ${dirs.length} Claude Code transcript ${dirs.length === 1 ? 'directory' : 'directories'} for live updates.`
                : 'Live updates on, but no Claude Code transcript directory exists yet — it is picked up on the next refresh/restart.',
            );
          },
          onError: (err) => logger.error('Claude Code watcher error', err),
        }),
      );
    }

    liveController = controller;
    void controller.start();
  };

  registerCommands(context, refreshables, {
    consent,
    secrets,
    syncEngine,
    openSession: (sourceId, sessionKey) => detailPanels.open(sourceId, sessionKey),
    openCombinedSession: (sessionList) => detailPanels.openCombined(sessionList),
    openRepositoryDetail: (repos) => detailPanels.openRepository(repos),
    refreshSessionDetail: () => detailPanels.refreshActive(),
    // LOCAL-ONLY preview of the outgoing aggregate payload. Builds a real batch
    // from local telemetry using the SecretStorage salt + local git identity and
    // opens it as a read-only untitled JSON document. Runs regardless of consent
    // (preview != upload) and never sends anything.
    previewPayload: () => {
      // Preview the SAME union the SyncEngine uploads (Copilot + Claude), so the
      // preview faithfully represents the outgoing batch.
      void runPreviewPayload(aggregationSource, secrets, toolVersion);
    },
    // LOCAL-ONLY: pick which repositories cloud sync includes. Reads the repos
    // present in local telemetry, writes the selection to USER settings, and
    // never uploads anything (the scope-change listener below rewinds the
    // watermark so newly-included repos backfill on the next sync).
    configureSyncRepositories: () => {
      void runConfigureSyncRepositories(config, telemetry);
    },
    // LOCAL-ONLY: pick which repositories the extension hides entirely (from
    // the local views AND the sync/preview aggregate rows). Reads the repos
    // visible across every enabled source, writes the unchecked ones to USER
    // settings, and never uploads anything. The config-change listener below
    // re-renders the views and rewinds the sync watermark (an un-hidden
    // repository must backfill).
    configureExcludedRepositories: () => {
      void runConfigureExcludedRepositories(config, registry);
    },
    // Focus the AI Helper view; `<viewId>.focus` is auto-registered by VS Code.
    openAssistant: () => {
      void vscode.commands.executeCommand(`${ASSISTANT_VIEW_ID}.focus`);
    },
    newChat: () => assistant.newChat(),
    enableLiveUpdates: () => {
      // Write the settings, then start the pipeline immediately: the Claude
      // watcher goes live now (no restart); Copilot's exporter still needs a
      // full restart, but the receiver is already listening for it.
      void runEnableLiveUpdates(config, logger).then(() => startLive());
    },
    disableLiveUpdates: () => {
      stopLive();
      void runDisableLiveUpdates(telemetry, logger);
    },
    showLogs: () => logger.show(),
    logger,
  });

  // `@obs` chat participant — lives in the GitHub Copilot chat window and renders
  // buttons that open the LOCAL session-detail webview. Reads local telemetry
  // only; nothing is uploaded. No-ops on hosts without the chat API.
  registerObservabilityChatParticipant(context, telemetry);

  // Background scheduler — OFF by default (sync.enabled=false). It still re-checks
  // the consent+key gate on every tick, and refreshes the Sync view after a run.
  const scheduler = new SyncScheduler(config, syncEngine, () => sync.refresh());
  syncScheduler = scheduler;
  scheduler.start();

  // Prime the divergence-notifier baseline so a freshly-opened window does not
  // toast for pre-existing history; subsequent refreshes notify only NEW ones.
  divergenceNotifier.scan();

  // Content-free activation summary (sources + feature-flag state). Useful when a
  // user reports "I see no sessions" — the log shows which sources were enabled.
  const sourceStates = registry.all().map((s) => `${s.label}=${s.isEnabled() ? 'on' : 'off'}`);
  logger.info(
    `Activated v${toolVersion}. Sources: ${sourceStates.join(', ')}. ` +
      `Live updates: ${config.isLiveUpdatesEnabled() ? 'on' : 'off'}.`,
  );

  // Start the real-time pipeline (no-op unless live updates are enabled). The
  // controller runs the Copilot OTLP receiver and the Claude transcript watcher,
  // coalescing their signals into one debounced refresh. Everything stays local;
  // nothing is uploaded.
  startLive();

  // Start the durable Copilot archive (on by default). Runs regardless of live
  // updates; nothing is uploaded.
  startArchiver();

  // Keep the Sync view live when consent flips (set-key already refreshes via
  // the command path, but consent can also change programmatically).
  context.subscriptions.push(consent.onDidChange(() => sync.refresh()));

  // Dispose every source (Copilot snapshot/connection + Claude caches), detail
  // panels, consent emitter, scheduler.
  context.subscriptions.push({ dispose: () => registry.dispose() });
  context.subscriptions.push({ dispose: () => detailPanels.dispose() });
  context.subscriptions.push({ dispose: () => consent.dispose() });
  context.subscriptions.push({ dispose: () => scheduler.dispose() });
  context.subscriptions.push({ dispose: () => stopLive() });
  context.subscriptions.push({ dispose: () => stopArchiver() });

  // On configuration change (e.g. toggling the feature flag, sqlitePath, or the
  // sync.enabled/intervalMinutes settings), drop the cached snapshot, re-arm the
  // scheduler, and re-render the views.
  context.subscriptions.push(
    config.onDidChange(() => {
      registry.refresh();
      scheduler.reschedule();
      overview.refresh();
      sessions.refresh();
      sync.refresh();
      // Workflows or the notify flag may have changed — re-baseline so we never
      // retroactively toast for historical divergences the new config now matches.
      divergenceNotifier.resetBaseline();
      divergenceNotifier.scan();
    }),
  );

  // When the repository sync SCOPE changes, forget the watermark so the next run
  // re-scans the full local window — newly-included repositories backfill rather
  // than being skipped because their window was already marked sent. Re-sending
  // is idempotent (server upserts by rowKey) and the local DB is a short rolling
  // window, so the catch-up is bounded. `excludedRepositories` is part of the
  // effective scope too: un-hiding a repository must backfill it the same way.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.syncRepositoryMode}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.syncRepositories}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.excludedRepositories}`)
      ) {
        void syncState.clearWatermark().then(() => sync.refresh());
      }
      // Re-arm the archiver when its enable/retention/sweep/path settings change
      // (re-reads config; toggling off detaches the archive as the read source).
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.copilotArchiveEnabled}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.copilotArchiveRetentionDays}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.copilotArchiveSweepSeconds}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.copilotArchivePath}`)
      ) {
        startArchiver();
      }
      // The live-update settings are USER-scoped and shared by every window, so
      // the Enable/Disable commands run in ONE window reach the others through
      // this event: re-arm the pipeline so each window re-runs the port election
      // (one becomes the receiver, the rest follow it as readers) instead of
      // staying on a stale port — or staying up after a disable — until restart.
      if (
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.liveUpdatesEnabled}`) ||
        event.affectsConfiguration(`${CONFIG_SECTION}.${ConfigKeys.liveOtelPort}`)
      ) {
        startLive();
      }
    }),
  );
}

/**
 * `enableLiveUpdates` handler. Points GitHub Copilot Chat's OpenTelemetry
 * `otlp-http` exporter at the extension's localhost receiver (a free port stored
 * in `liveUpdates.otelPort`), enables content capture, and flips the extension's
 * `liveUpdates.enabled` on. All Copilot settings are written at USER (Global)
 * scope — the only scope `exporterType` honors — and a FULL VS Code restart is
 * required (Copilot reads these at application startup; a window reload does NOT
 * re-read them). Everything stays local; nothing is uploaded.
 */
async function runEnableLiveUpdates(config: Configuration, logger: Logger): Promise<void> {
  void config;
  let port: number;
  try {
    port = await findFreePort();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Could not find a free port for live updates', err);
    void vscode.window.showErrorMessage(`Agent Observability: could not find a free port (${message}).`);
    return;
  }

  const ao = vscode.workspace.getConfiguration('agentObservability');
  await ao.update('liveUpdates.otelPort', port, vscode.ConfigurationTarget.Global);
  await ao.update('liveUpdates.enabled', true, vscode.ConfigurationTarget.Global);

  try {
    // 'github.copilot.chat' + 'otel.*' → the full 'github.copilot.chat.otel.*' ids.
    // exporterType is MACHINE-scoped, so it must be written at Global (USER) scope.
    const otel = vscode.workspace.getConfiguration('github.copilot.chat');
    await otel.update('otel.enabled', true, vscode.ConfigurationTarget.Global);
    await otel.update('otel.exporterType', 'otlp-http', vscode.ConfigurationTarget.Global);
    await otel.update('otel.otlpEndpoint', `http://127.0.0.1:${port}`, vscode.ConfigurationTarget.Global);
    await otel.update('otel.captureContent', true, vscode.ConfigurationTarget.Global);
    // File logging pins the exporter to 'file'; turn it off so otlp-http wins.
    await otel.update('agentDebugLog.fileLogging.enabled', false, vscode.ConfigurationTarget.Global);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Could not configure Copilot's OpenTelemetry exporter", err);
    void vscode.window.showErrorMessage(
      `Agent Observability: could not configure Copilot's OpenTelemetry exporter (${message}). Ensure the GitHub Copilot Chat extension is installed.`,
    );
    return;
  }

  logger.info(`Live updates enabled — Copilot OTel pointed at http://127.0.0.1:${port} (restart required).`);
  void vscode.window.showWarningMessage(
    'Agent Observability: real-time updates enabled. Claude Code sessions update live now (no restart). ' +
      `For Copilot (→ http://127.0.0.1:${port}) you must FULLY QUIT and reopen VS Code — a window reload is NOT enough for Copilot to switch exporters.`,
  );
}

/**
 * `disableLiveUpdates` handler. Turns the extension's live updates off, detaches
 * the ingest source, and best-effort disables Copilot's OTel exporter. The live
 * pipeline (OTLP receiver + Claude watcher) is stopped by the command wrapper via
 * `stopLive()` before this runs. A full restart fully reverts Copilot's exporter.
 */
async function runDisableLiveUpdates(telemetry: TelemetryService, logger: Logger): Promise<void> {
  const ao = vscode.workspace.getConfiguration('agentObservability');
  await ao.update('liveUpdates.enabled', false, vscode.ConfigurationTarget.Global);
  try {
    const otel = vscode.workspace.getConfiguration('github.copilot.chat');
    await otel.update('otel.enabled', false, vscode.ConfigurationTarget.Global);
  } catch {
    // Copilot Chat may be absent; nothing to turn off.
  }
  telemetry.setIngestDbPath(undefined);
  logger.info('Live updates disabled; receiver + watcher stopped.');
  void vscode.window.showInformationMessage(
    'Agent Observability: real-time updates disabled. Fully quit + reopen VS Code to fully revert Copilot’s exporter.',
  );
}

/** Find a free localhost TCP port by binding an ephemeral one, then releasing it. */
function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Semver of the running extension, used as the batch `toolVersion`. */
function readToolVersion(context: vscode.ExtensionContext): string {
  const raw = (context.extension?.packageJSON as { version?: unknown } | undefined)?.version;
  // Fall back to a valid semver so the preview always validates against the schema
  // pattern even in odd packaging states.
  return typeof raw === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+/.test(raw) ? raw : '0.0.0';
}

/**
 * Build the aggregate batch for ALL available local telemetry and open it as a
 * read-only untitled JSON document. LOCAL-ONLY: nothing is uploaded. Runs
 * regardless of consent because previewing != sharing.
 */
async function runPreviewPayload(
  aggregation: SyncTelemetry,
  secrets: SecretManager,
  toolVersion: string,
): Promise<void> {
  const result = aggregation.getAggregationRows();
  if (!result.ok) {
    void vscode.window.showInformationMessage(
      `Agent Observability: cannot build a preview payload — ${result.message} Nothing was uploaded.`,
    );
    return;
  }
  const rows = result.value;

  // Window: span the full range of available data (closed-open). When there is no
  // data, default to the last 7 days so an empty heartbeat batch still validates.
  const now = Date.now();
  let windowStartMs = now - 7 * 24 * 60 * 60 * 1000;
  let windowEndMs = now;
  if (rows.length > 0) {
    let min = rows[0].startTimeMs;
    let max = rows[0].startTimeMs;
    for (const r of rows) {
      if (r.startTimeMs < min) {
        min = r.startTimeMs;
      }
      if (r.startTimeMs > max) {
        max = r.startTimeMs;
      }
    }
    windowStartMs = min;
    // End is EXCLUSIVE and MUST be > start; cover the last span's bin fully.
    windowEndMs = max + 1;
  }

  // Salt (SecretStorage; never shipped) + local git identity (never shipped) →
  // pseudonymous developer id, which is the ONLY identity-derived value emitted.
  const saltHex = await secrets.getOrCreatePseudonymSalt();
  const workspaceCwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const { input } = getIdentityInput(workspaceCwd, vscode.env.machineId);
  const pseudonymousDeveloperId = computeDeveloperId(saltHex, input);

  const batch = buildBatch({
    rows,
    pseudonymousDeveloperId,
    toolVersion,
    windowStartMs,
    windowEndMs,
  });

  const header = [
    '// Agent Observability — LOCAL PREVIEW of the outgoing aggregate payload.',
    '// This batch has NOT been uploaded. It is shown locally for inspection only.',
    '// Raw prompts, completions, tool I/O, file paths, and your identity are never included;',
    '// only the pre-aggregated, non-sensitive measures below would ever be shared (on opt-in).',
  ].join('\n');
  const content = `${header}\n${JSON.stringify(batch, null, 2)}\n`;

  const doc = await vscode.workspace.openTextDocument({ content, language: 'json' });
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** Sentinel value for sessions with no detected git remote (matches the row value). */
const UNKNOWN_REPOSITORY = 'unknown';

/**
 * `configureSyncRepositories` handler. Presents a checklist of the repositories
 * found in local telemetry (plus any already configured but no longer present,
 * so a saved scope is never silently dropped), pre-checked to reflect the
 * current scope, and writes the result to USER settings.
 *
 * Normalization keeps the round-trip intuitive: checking EVERYTHING writes mode
 * `all` (no filter); checking a strict subset writes mode `include` with that
 * subset. LOCAL-ONLY — it reads on-machine telemetry and writes settings; it
 * never uploads. The scope-change listener rewinds the sync watermark.
 */
async function runConfigureSyncRepositories(
  config: Configuration,
  telemetry: TelemetryService,
): Promise<void> {
  const result = telemetry.getDistinctRepositories();
  if (!result.ok) {
    void vscode.window.showInformationMessage(
      `Agent Observability: cannot list repositories — ${result.message}`,
    );
    return;
  }

  const policy = config.getRepoSyncPolicy();
  // Union telemetry repos with any already-configured ones so a previously
  // included/excluded repo that has aged out of local telemetry still appears
  // and is not silently forgotten on save.
  const allRepos = [...new Set([...result.value, ...policy.repositories])].sort();

  if (allRepos.length === 0) {
    void vscode.window.showInformationMessage(
      'Agent Observability: no repositories found in local telemetry yet. Use Copilot in a repository, then try again.',
    );
    return;
  }

  interface RepoPick extends vscode.QuickPickItem {
    repository: string;
  }
  const items: RepoPick[] = allRepos.map((repository) => ({
    repository,
    label: repository === UNKNOWN_REPOSITORY ? '$(question) No detected git remote' : repository,
    description: repository === UNKNOWN_REPOSITORY ? 'unknown' : undefined,
    // Pre-check what currently syncs: all → everything; include → listed;
    // exclude → everything not listed.
    picked:
      policy.mode === 'all'
        ? true
        : policy.mode === 'include'
          ? policy.repositories.has(repository)
          : !policy.repositories.has(repository),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Choose Repositories to Sync',
    placeHolder: 'Check the repositories whose aggregates may be uploaded. Unchecked repositories stay local.',
    ignoreFocusOut: true,
  });
  if (picked === undefined) {
    return; // dismissed — no change
  }

  const selected = picked.map((p) => p.repository);
  // Checking everything means "no filter" → mode all; a subset → include list.
  const nextMode: RepoSyncMode = selected.length === allRepos.length ? 'all' : 'include';
  const nextList = nextMode === 'all' ? [] : selected;

  const ao = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await ao.update(ConfigKeys.syncRepositoryMode, nextMode, vscode.ConfigurationTarget.Global);
  await ao.update(ConfigKeys.syncRepositories, nextList, vscode.ConfigurationTarget.Global);

  void vscode.window.showInformationMessage(
    nextMode === 'all'
      ? `Agent Observability: cloud sync now includes all ${allRepos.length} repositories.`
      : `Agent Observability: cloud sync now includes ${selected.length} of ${allRepos.length} repositories.`,
  );
}

/**
 * `configureExcludedRepositories` handler. Presents a checklist of every
 * repository visible across the enabled sources — plus the already-hidden ones
 * (which the filtered listings no longer report), so a hidden repository can
 * always be un-hidden even after it ages out of local telemetry. Checked =
 * shown; the UNCHECKED repositories are written to `excludedRepositories` in
 * USER settings and disappear from the local views and the sync/preview
 * aggregate rows. LOCAL-ONLY — the underlying telemetry is untouched, so
 * re-checking a repository brings it straight back.
 */
async function runConfigureExcludedRepositories(
  config: Configuration,
  registry: SourceRegistry,
): Promise<void> {
  const excluded = config.getExcludedRepositories();

  // Visible repositories across every enabled source. The Copilot tree shows
  // no-remote sessions ungrouped rather than as a repository row, so probe for
  // them explicitly — `unknown` must be offered when such sessions exist.
  const visible = new Set<string>();
  for (const source of registry.enabled()) {
    const repos = source.listRepositories();
    if (repos.ok) {
      for (const repo of repos.value) {
        visible.add(repo.repository);
      }
    }
    const ungrouped = source.listSessions(UNKNOWN_REPOSITORY, 1);
    if (ungrouped.ok && ungrouped.value.length > 0) {
      visible.add(UNKNOWN_REPOSITORY);
    }
  }

  const allRepos = [...new Set([...visible, ...excluded])].sort();
  if (allRepos.length === 0) {
    void vscode.window.showInformationMessage(
      'Agent Observability: no repositories found in local telemetry yet. Use an agent in a repository, then try again.',
    );
    return;
  }

  interface RepoPick extends vscode.QuickPickItem {
    repository: string;
  }
  const items: RepoPick[] = allRepos.map((repository) => ({
    repository,
    label: repository === UNKNOWN_REPOSITORY ? '$(question) No detected git remote' : repository,
    description: repository === UNKNOWN_REPOSITORY ? 'unknown' : undefined,
    picked: !excluded.has(repository),
  }));

  const picked = await vscode.window.showQuickPick(items, {
    canPickMany: true,
    title: 'Choose Repositories to Hide',
    placeHolder:
      'Check the repositories to show. Unchecked repositories are hidden from the extension and excluded from sync.',
    ignoreFocusOut: true,
  });
  if (picked === undefined) {
    return; // dismissed — no change
  }

  const shown = new Set(picked.map((p) => p.repository));
  const hidden = allRepos.filter((repository) => !shown.has(repository));

  const ao = vscode.workspace.getConfiguration(CONFIG_SECTION);
  await ao.update(ConfigKeys.excludedRepositories, hidden, vscode.ConfigurationTarget.Global);

  void vscode.window.showInformationMessage(
    hidden.length === 0
      ? `Agent Observability: showing all ${allRepos.length} repositories.`
      : `Agent Observability: hiding ${hidden.length} of ${allRepos.length} repositories. Local data is untouched — re-run this command to bring them back.`,
  );
}

/** Dispose the telemetry snapshot copy + connection and any open detail panels. */
export function deactivate(): void {
  // Disposing the registry tears down every source (incl. the Copilot snapshot).
  sources?.dispose();
  sources = undefined;
  sessionDetailPanels?.dispose();
  sessionDetailPanels = undefined;
  consentManager?.dispose();
  consentManager = undefined;
  syncScheduler?.dispose();
  syncScheduler = undefined;
  liveController?.stop();
  liveController = undefined;
  copilotArchiver?.stop();
  copilotArchiver = undefined;
}
