import * as vscode from 'vscode';
import * as path from 'node:path';
import * as net from 'node:net';
import { Configuration } from './config/configuration';
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
import { SyncEngine, SyncContextInsightsSource, systemClock } from './sync/syncEngine';
import { SyncScheduler } from './sync/scheduler';
import { registerObservabilityChatParticipant } from './chat/observabilityChat';
import { ChatViewProvider, ASSISTANT_VIEW_ID } from './chat/webview/chatViewProvider';
import { WorkflowDivergenceNotifier } from './notify/workflowDivergenceNotifier';
import { LiveOtlpService } from './otel/liveOtlpService';

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
let telemetryService: TelemetryService | undefined;
let sessionDetailPanels: SessionDetailPanelManager | undefined;
let consentManager: ConsentManager | undefined;
let syncScheduler: SyncScheduler | undefined;
let liveOtlp: LiveOtlpService | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const config = new Configuration();
  const telemetry = new TelemetryService(config);
  telemetryService = telemetry;

  // Consent + secret management (Phase 4). Both are constructed from the
  // extension context: consent in globalState, secrets in SecretStorage.
  const consent = new ConsentManager(context);
  consentManager = consent;
  const secrets = new SecretManager(context);

  // Local-only workflow deviation detection for the session-detail webview.
  const deviations = new LocalDeviationDetector(config);
  const detailPanels = new SessionDetailPanelManager(telemetry, deviations);
  sessionDetailPanels = detailPanels;

  // Proactive per-turn workflow-divergence notifications (off by default). After a
  // refresh it scans settled turns of recently-active sessions in repositories
  // with configured workflows and toasts NEW divergences, opening the
  // session-detail panel on click. Local-only — nothing is uploaded.
  const divergenceNotifier = new WorkflowDivergenceNotifier(
    config,
    telemetry,
    deviations,
    (sessionKey) => detailPanels.open(sessionKey),
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
        if (deviations.detectForSession(interactions.value, contentLookup).length > 0) {
          flagged.add(sessionKey);
        }
      }
      return flagged;
    },
  };
  const syncEngine = new SyncEngine(
    config,
    consent,
    secrets,
    telemetry,
    syncClient,
    syncState,
    systemClock,
    {
      toolVersion,
      workspaceCwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      machineId: vscode.env.machineId,
    },
    contextInsightsSource,
  );

  // Construct the view providers, backed by the telemetry service.
  const overview = new OverviewViewProvider(telemetry);
  const sessions = new SessionsViewProvider(telemetry);
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

  // Refresh re-snapshots local telemetry, then fans out to every view.
  const telemetryRefresh: Refreshable = { refresh: () => telemetry.refresh() };
  const refreshables: Refreshable[] = [telemetryRefresh, overview, sessions, sync, divergenceNotifier];
  registerCommands(context, refreshables, {
    consent,
    secrets,
    syncEngine,
    openSession: (sessionKey) => detailPanels.open(sessionKey),
    openCombinedSession: (sessionKeys) => detailPanels.openCombined(sessionKeys),
    refreshSessionDetail: () => detailPanels.refreshActive(),
    // LOCAL-ONLY preview of the outgoing aggregate payload. Builds a real batch
    // from local telemetry using the SecretStorage salt + local git identity and
    // opens it as a read-only untitled JSON document. Runs regardless of consent
    // (preview != upload) and never sends anything.
    previewPayload: () => {
      void runPreviewPayload(telemetry, secrets, toolVersion);
    },
    // Focus the AI Helper view; `<viewId>.focus` is auto-registered by VS Code.
    openAssistant: () => {
      void vscode.commands.executeCommand(`${ASSISTANT_VIEW_ID}.focus`);
    },
    newChat: () => assistant.newChat(),
    enableLiveUpdates: () => {
      void runEnableLiveUpdates(config);
    },
    disableLiveUpdates: () => {
      void runDisableLiveUpdates(telemetry);
    },
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

  // Real-time OTLP sink. When live updates are enabled, run a localhost receiver
  // that ingests Copilot's pushed OTLP spans into the extension's OWN DB (Copilot
  // schema) and refreshes the views + notifier on each batch. The extension is the
  // sink; nothing is uploaded. Copilot must be pointed here via "Enable Live
  // Updates" (which also requires a FULL VS Code restart to switch exporters).
  if (config.isLiveUpdatesEnabled()) {
    const ingestDbPath = path.join(context.globalStorageUri.fsPath, 'ingest', 'agent-traces.db');
    const refreshLive = (): void => {
      for (const r of refreshables) {
        r.refresh();
      }
      detailPanels.refreshActive();
    };
    const service = new LiveOtlpService({
      ingestDbPath,
      port: config.getLiveOtelPort(),
      debounceMs: config.getLiveDebounceMs(),
      onIngest: refreshLive,
    });
    liveOtlp = service;
    void service
      .start()
      .then(() => {
        // The ingest DB now exists → make it the sole source, then render.
        telemetry.setIngestDbPath(ingestDbPath);
        refreshLive();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        void vscode.window.showErrorMessage(
          'Agent Observability: could not start the real-time OTLP receiver on port ' +
            `${config.getLiveOtelPort()} (${message}). Re-run “Enable Live Updates”.`,
        );
      });
  }

  // Keep the Sync view live when consent flips (set-key already refreshes via
  // the command path, but consent can also change programmatically).
  context.subscriptions.push(consent.onDidChange(() => sync.refresh()));

  // Dispose the snapshot + connection, detail panels, consent emitter, scheduler.
  context.subscriptions.push({ dispose: () => telemetry.dispose() });
  context.subscriptions.push({ dispose: () => detailPanels.dispose() });
  context.subscriptions.push({ dispose: () => consent.dispose() });
  context.subscriptions.push({ dispose: () => scheduler.dispose() });
  context.subscriptions.push({ dispose: () => liveOtlp?.stop() });

  // On configuration change (e.g. toggling the feature flag, sqlitePath, or the
  // sync.enabled/intervalMinutes settings), drop the cached snapshot, re-arm the
  // scheduler, and re-render the views.
  context.subscriptions.push(
    config.onDidChange(() => {
      telemetry.refresh();
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
async function runEnableLiveUpdates(config: Configuration): Promise<void> {
  void config;
  let port: number;
  try {
    port = await findFreePort();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
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
    void vscode.window.showErrorMessage(
      `Agent Observability: could not configure Copilot's OpenTelemetry exporter (${message}). Ensure the GitHub Copilot Chat extension is installed.`,
    );
    return;
  }

  void vscode.window.showWarningMessage(
    `Agent Observability: real-time telemetry enabled (Copilot → http://127.0.0.1:${port}). ` +
      'You must FULLY QUIT and reopen VS Code — a window reload is NOT enough for Copilot to switch exporters.',
  );
}

/**
 * `disableLiveUpdates` handler. Turns the extension's live updates off, stops the
 * receiver, detaches the ingest source, and best-effort disables Copilot's OTel
 * exporter. A full restart fully reverts Copilot's exporter selection.
 */
async function runDisableLiveUpdates(telemetry: TelemetryService): Promise<void> {
  const ao = vscode.workspace.getConfiguration('agentObservability');
  await ao.update('liveUpdates.enabled', false, vscode.ConfigurationTarget.Global);
  try {
    const otel = vscode.workspace.getConfiguration('github.copilot.chat');
    await otel.update('otel.enabled', false, vscode.ConfigurationTarget.Global);
  } catch {
    // Copilot Chat may be absent; nothing to turn off.
  }
  liveOtlp?.stop();
  liveOtlp = undefined;
  telemetry.setIngestDbPath(undefined);
  void vscode.window.showInformationMessage(
    'Agent Observability: real-time telemetry disabled. Fully quit + reopen VS Code to fully revert Copilot’s exporter.',
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
  telemetry: TelemetryService,
  secrets: SecretManager,
  toolVersion: string,
): Promise<void> {
  const result = telemetry.getAggregationRows();
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

/** Dispose the telemetry snapshot copy + connection and any open detail panels. */
export function deactivate(): void {
  telemetryService?.dispose();
  telemetryService = undefined;
  sessionDetailPanels?.dispose();
  sessionDetailPanels = undefined;
  consentManager?.dispose();
  consentManager = undefined;
  syncScheduler?.dispose();
  syncScheduler = undefined;
  liveOtlp?.stop();
  liveOtlp = undefined;
}
