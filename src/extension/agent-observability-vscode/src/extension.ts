import * as vscode from 'vscode';
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
import { SyncEngine, systemClock } from './sync/syncEngine';
import { SyncScheduler } from './sync/scheduler';
import { registerObservabilityChatParticipant } from './chat/observabilityChat';

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

  // Phase 7 sync wiring. The state store persists the watermark + run history;
  // the client transports batches via globalThis.fetch (vscode extension host).
  const toolVersion = readToolVersion(context);
  const syncState = new GlobalStateSyncStateStore(context.globalState);
  const syncClient = new SyncClient(
    new FetchHttpPoster(),
    () => config.getDashboardUrl(),
    () => secrets.getApiKey(),
  );
  const syncEngine = new SyncEngine(config, consent, secrets, telemetry, syncClient, syncState, systemClock, {
    toolVersion,
    workspaceCwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    machineId: vscode.env.machineId,
  });

  // Construct the view providers, backed by the telemetry service.
  const overview = new OverviewViewProvider(telemetry);
  const sessions = new SessionsViewProvider(telemetry);
  const sync = new SyncViewProvider(config, telemetry, consent, secrets, syncState);

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
  const refreshables: Refreshable[] = [telemetryRefresh, overview, sessions, sync];
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

  // Keep the Sync view live when consent flips (set-key already refreshes via
  // the command path, but consent can also change programmatically).
  context.subscriptions.push(consent.onDidChange(() => sync.refresh()));

  // Dispose the snapshot + connection, detail panels, consent emitter, scheduler.
  context.subscriptions.push({ dispose: () => telemetry.dispose() });
  context.subscriptions.push({ dispose: () => detailPanels.dispose() });
  context.subscriptions.push({ dispose: () => consent.dispose() });
  context.subscriptions.push({ dispose: () => scheduler.dispose() });

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
    }),
  );
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
}
