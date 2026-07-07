import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../config/configuration';
import { ConsentManager } from '../consent/consentManager';
import { consentModalDetail } from '../consent/consentDisclosure';
import { SecretManager } from '../secrets/secretManager';
import { SyncEngine } from '../sync/syncEngine';
import { Logger } from '../log/logger';

/**
 * Stable command ids. These MUST match the `contributes.commands` entries in
 * package.json; later phases and menu `when` clauses reference these exact ids.
 */
export const Commands = {
  refresh: 'agentObservability.refresh',
  syncNow: 'agentObservability.syncNow',
  openSettings: 'agentObservability.openSettings',
  setApiKey: 'agentObservability.setApiKey',
  configureSyncRepositories: 'agentObservability.configureSyncRepositories',
  configureExcludedRepositories: 'agentObservability.configureExcludedRepositories',
  toggleConsent: 'agentObservability.toggleConsent',
  previewPayload: 'agentObservability.previewPayload',
  openSession: 'agentObservability.openSession',
  openCombinedSession: 'agentObservability.openCombinedSession',
  openRepository: 'agentObservability.openRepository',
  refreshSessionDetail: 'agentObservability.refreshSessionDetail',
  openAssistant: 'agentObservability.openAssistant',
  newChat: 'agentObservability.newChat',
  enableLiveUpdates: 'agentObservability.enableLiveUpdates',
  disableLiveUpdates: 'agentObservability.disableLiveUpdates',
  showLogs: 'agentObservability.showLogs',
  setCloudAccountToken: 'agentObservability.setCloudAccountToken',
} as const;

/** The required prefix of an organization API key (`aoa_<keyId>_<secret>`). */
const API_KEY_PREFIX = 'aoa_';

/**
 * The set of view providers a refresh should fan out to. Kept as a minimal
 * structural interface (not the concrete classes) so the command layer stays
 * decoupled from the view implementations — any object with `refresh()` works.
 */
export interface Refreshable {
  refresh(): void;
}

/**
 * Collaborators the command handlers need. Bundled so the registration seam
 * stays a single call and later phases can extend it (e.g. add the sync engine)
 * without re-threading every argument.
 */
export interface CommandDeps {
  consent: ConsentManager;
  secrets: SecretManager;
  /** Phase 7 sync engine — drives the real upload behind the consent+key gate. */
  syncEngine: SyncEngine;
  /** Open the LOCAL session-detail webview for a source's session key. */
  openSession: (sourceId: string, sessionKey: string) => void;
  /** Open a single LOCAL combined-detail webview over several sessions. */
  openCombinedSession: (sessions: Array<{ sourceId: string; sessionKey: string }>) => void;
  /** Open a LOCAL repository-details webview over one or more repositories. */
  openRepositoryDetail: (repos: Array<{ sourceId: string; repository: string }>) => void;
  /** Re-fetch local telemetry and redraw the focused session-detail webview. */
  refreshSessionDetail: () => void;
  /** Open the LOCAL aggregate-payload preview (Phase 5 surfaces real content). */
  previewPayload: () => void;
  /** Pick which repositories are included in cloud sync (writes user settings). */
  configureSyncRepositories: () => void;
  /** Pick which repositories the extension hides entirely (writes user settings). */
  configureExcludedRepositories: () => void;
  /** Reveal/focus the AI Helper webview view. */
  openAssistant: () => void;
  /** Clear the AI Helper conversation (start a new chat). */
  newChat: () => void;
  /** Turn on near-real-time live updates (configures Copilot's OTel file exporter). */
  enableLiveUpdates: () => void;
  /** Turn off near-real-time live updates. */
  disableLiveUpdates: () => void;
  /** Reveal the extension's diagnostic Output channel. */
  showLogs: () => void;
  /** Content-free diagnostic log; manual sync outcomes are recorded here. */
  logger: Logger;
}

/** Fan out a refresh to every registered view provider. */
function refreshAll(refreshables: Refreshable[]): void {
  for (const r of refreshables) {
    r.refresh();
  }
}

/**
 * Registers all command handlers and pushes their disposables onto the
 * extension context. Phase 4 wires the real consent + secret handlers; the
 * registration shape (and ids) is the stable seam later phases replace handler
 * bodies within.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  refreshables: Refreshable[],
  deps: CommandDeps,
): void {
  const {
    consent,
    secrets,
    syncEngine,
    openSession,
    openCombinedSession,
    openRepositoryDetail,
    refreshSessionDetail,
    previewPayload,
    configureSyncRepositories,
    configureExcludedRepositories,
    openAssistant,
    newChat,
    enableLiveUpdates,
    disableLiveUpdates,
    showLogs,
    logger,
  } = deps;

  const register = (id: string, handler: (...args: unknown[]) => unknown): void => {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  };

  // Refresh fans out to every registered view provider.
  register(Commands.refresh, () => {
    refreshAll(refreshables);
  });

  // Sync Now — gated on consent + API key (the engine re-checks the gate and
  // never uploads when it is closed). Drives the real Phase 7 upload behind a
  // progress notification and refreshes the views with the outcome.
  register(Commands.syncNow, () => {
    void runSyncNow(syncEngine, logger, () => refreshAll(refreshables));
  });

  // Open the extension's settings filtered to this section.
  register(Commands.openSettings, () => {
    void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:turbinestudios.agent-observability')
      .then(undefined, () => {
        // Fallback: filter by the config section if the ext filter is unsupported.
        void vscode.commands.executeCommand('workbench.action.openSettings', CONFIG_SECTION);
      });
  });

  // Set Organization API Key — validate format, store in SecretStorage, never
  // echo the key. Offer Replace/Clear when a key already exists.
  register(Commands.setApiKey, () => {
    void runSetApiKey(secrets, () => refreshAll(refreshables));
  });

  // Set a Copilot (Cloud) account token — masked input keyed by account label,
  // stored in SecretStorage; the escape hatch for accounts not logged into gh.
  register(Commands.setCloudAccountToken, () => {
    void runSetCloudAccountToken(secrets, () => refreshAll(refreshables));
  });

  // Toggle Cloud Sharing — flip consent behind an explicit disclosure modal.
  register(Commands.toggleConsent, () => {
    void runToggleConsent(consent);
  });

  // Preview the outgoing aggregate payload (LOCAL only; nothing is uploaded).
  register(Commands.previewPayload, () => {
    previewPayload();
  });

  // Choose which repositories are included in cloud sync. Opens a checklist of
  // the repositories found in local telemetry and writes the selection to USER
  // settings. Never uploads — it only narrows what a later sync would send.
  register(Commands.configureSyncRepositories, () => {
    configureSyncRepositories();
  });

  // Choose which repositories the extension HIDES everywhere — the local views
  // AND the sync/preview aggregate rows. Writes USER settings only; the local
  // data is untouched, so re-checking a repository brings it straight back.
  register(Commands.configureExcludedRepositories, () => {
    configureExcludedRepositories();
  });

  // Open Session Detail — invoked by a session TreeItem with (sourceId, key),
  // or (legacy, e.g. the @obs chat participant) with a bare key → Copilot.
  register(Commands.openSession, (a?: unknown, b?: unknown) => {
    if (typeof a === 'string' && typeof b === 'string' && b.length > 0) {
      openSession(a, b);
    } else if (typeof a === 'string' && a.length > 0) {
      openSession('copilot', a);
    }
  });

  // Open Combined Session Detail — invoked from the Sessions view context menu
  // when one or more session rows are selected. VS Code passes the focused node
  // first and the full multi-selection second; we combine the selected sessions
  // into a single LOCAL webview. All detail stays on-machine.
  register(Commands.openCombinedSession, (...args: unknown[]) => {
    const sessions = sourceSessionsFromCommandArgs(args);
    if (sessions.length > 0) {
      openCombinedSession(sessions);
    }
  });

  // Open Repository Details — the inline (hover) button / context-menu action on
  // repository rows in the Sessions view. A multi-selection of repository rows
  // opens ONE combined repository view. All detail stays on-machine.
  register(Commands.openRepository, (...args: unknown[]) => {
    const repos = sourceRepositoriesFromCommandArgs(args);
    if (repos.length > 0) {
      openRepositoryDetail(repos);
    }
  });

  // Refresh Session Detail — title-bar button on the LOCAL session-detail webview
  // (single or combined). Re-snapshots local telemetry and redraws the focused
  // panel, the same fresh data a navigation click would load after a refresh.
  register(Commands.refreshSessionDetail, () => {
    refreshSessionDetail();
  });

  // Reveal the AI Helper webview view in the activity-bar container.
  register(Commands.openAssistant, () => {
    openAssistant();
  });

  // Start a fresh AI Helper conversation (title-bar "+" on the AI Helper view).
  register(Commands.newChat, () => {
    newChat();
  });

  // Enable/Disable near-real-time live updates. The handlers (in extension.ts)
  // write Copilot's `github.copilot.chat.otel.*` settings + the extension's
  // `liveUpdates.*` settings and (re)start the live pipeline — the Copilot OTLP
  // receiver and the Claude transcript watcher. All local; no upload.
  register(Commands.enableLiveUpdates, () => {
    enableLiveUpdates();
  });
  register(Commands.disableLiveUpdates, () => {
    disableLiveUpdates();
  });

  // Reveal the diagnostic Output channel ("Agent Observability").
  register(Commands.showLogs, () => {
    showLogs();
  });
}

/**
 * Extract (sourceId, sessionKey) pairs from a tree context-menu invocation. VS
 * Code passes `(focusedNode, selectedNodes[])`; we prefer the multi-selection and
 * fall back to the focused node. Each session node carries `sourceId` +
 * `sessionKey`; nodes missing either are ignored.
 */
function sourceSessionsFromCommandArgs(args: unknown[]): Array<{ sourceId: string; sessionKey: string }> {
  const selection = Array.isArray(args[1]) ? (args[1] as unknown[]) : [args[0]];
  const out: Array<{ sourceId: string; sessionKey: string }> = [];
  for (const node of selection) {
    const n = node as { sourceId?: unknown; sessionKey?: unknown } | undefined;
    if (typeof n?.sessionKey === 'string' && n.sessionKey.length > 0) {
      const sourceId = typeof n.sourceId === 'string' && n.sourceId.length > 0 ? n.sourceId : 'copilot';
      out.push({ sourceId, sessionKey: n.sessionKey });
    }
  }
  return out;
}

/**
 * Extract (sourceId, repository) pairs from a tree invocation — the repository
 * counterpart to {@link sourceSessionsFromCommandArgs}. Only repository rows carry
 * `repository` (session rows carry `sessionKey` instead), so a mixed selection is
 * filtered to repository rows; duplicates are collapsed.
 */
function sourceRepositoriesFromCommandArgs(args: unknown[]): Array<{ sourceId: string; repository: string }> {
  const selection = Array.isArray(args[1]) ? (args[1] as unknown[]) : [args[0]];
  const out: Array<{ sourceId: string; repository: string }> = [];
  const seen = new Set<string>();
  for (const node of selection) {
    const n = node as { sourceId?: unknown; repository?: unknown; sessionKey?: unknown } | undefined;
    if (typeof n?.repository !== 'string' || n.repository.length === 0 || typeof n?.sessionKey === 'string') {
      continue;
    }
    const sourceId = typeof n.sourceId === 'string' && n.sourceId.length > 0 ? n.sourceId : 'copilot';
    const key = `${sourceId}::${n.repository}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ sourceId, repository: n.repository });
    }
  }
  return out;
}

/**
 * `syncNow` handler. Runs the Phase 7 {@link SyncEngine} behind a progress
 * notification, then surfaces a clear result. The engine itself enforces the
 * consent + API-key gate (no network when closed) and never logs the key/body.
 * After the run the views are refreshed so the Sync history updates.
 */
async function runSyncNow(syncEngine: SyncEngine, logger: Logger, onChanged: () => void): Promise<void> {
  logger.info('Manual sync requested.');
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Agent Observability: syncing aggregates…' },
    () => syncEngine.runSync({ manual: true }),
  );

  onChanged();

  switch (result.status) {
    case 'success':
      logger.info(`Manual sync uploaded ${result.bucketsSent} bucket(s).`);
      void vscode.window.showInformationMessage(
        `Agent Observability: uploaded ${result.bucketsSent} aggregate ${result.bucketsSent === 1 ? 'bucket' : 'buckets'}.`,
      );
      return;
    case 'upToDate':
      logger.info('Manual sync: already up to date.');
      void vscode.window.showInformationMessage('Agent Observability: already up to date — nothing new to upload.');
      return;
    case 'blocked':
      logger.warn(`Manual sync blocked: ${result.reason}`);
      void vscode.window.showInformationMessage(`Agent Observability: cannot sync — ${result.reason} Nothing was uploaded.`);
      return;
    case 'failed':
      logger.error(`Manual sync failed: ${result.message}`);
      void vscode.window.showErrorMessage(`Agent Observability: sync failed — ${result.message}`);
      return;
  }
}

/**
 * `setApiKey` handler. Prompts for the key (masked), validates the `aoa_`
 * prefix, stores it via {@link SecretManager}, and never echoes the value. When
 * a key already exists, first offers Replace / Clear.
 */
async function runSetApiKey(secrets: SecretManager, onChanged: () => void): Promise<void> {
  if (await secrets.hasApiKey()) {
    const choice = await vscode.window.showQuickPick(
      [
        { label: 'Replace key', detail: 'Enter a new organization API key (overwrites the stored one).', action: 'replace' as const },
        { label: 'Clear key', detail: 'Remove the stored organization API key. Sync will be blocked until a new key is set.', action: 'clear' as const },
      ],
      {
        title: 'Organization API key is already set',
        placeHolder: 'An API key is already stored. Replace or clear it?',
      },
    );
    if (choice === undefined) {
      return; // user dismissed
    }
    if (choice.action === 'clear') {
      await secrets.clearApiKey();
      onChanged();
      void vscode.window.showInformationMessage('Agent Observability: organization API key cleared.');
      return;
    }
    // fall through to prompt for a replacement
  }

  const key = await vscode.window.showInputBox({
    title: 'Set Organization API Key',
    prompt: "Paste the organization API key (format 'aoa_<keyId>_<secret>'). Stored securely in VS Code SecretStorage.",
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'aoa_…',
    validateInput: (value) => {
      const trimmed = value.trim();
      if (trimmed.length === 0) {
        return 'API key must not be empty.';
      }
      if (!trimmed.startsWith(API_KEY_PREFIX)) {
        return "API key must begin with 'aoa_'.";
      }
      return undefined;
    },
  });

  if (key === undefined) {
    return; // cancelled
  }
  const trimmed = key.trim();
  if (trimmed.length === 0 || !trimmed.startsWith(API_KEY_PREFIX)) {
    // Defensive: validateInput should have caught this.
    return;
  }

  await secrets.setApiKey(trimmed);
  onChanged();
  // Confirmation MUST NOT echo the key.
  void vscode.window.showInformationMessage(
    'Agent Observability: organization API key saved securely. It is stored only in VS Code SecretStorage and never uploaded or logged.',
  );
}

/**
 * `setCloudAccountToken` handler. Prompts for an account label then a masked
 * token, stores it in SecretStorage (never echoed), and refreshes. This is the
 * escape hatch for accounts not signed into `gh` / machines without `gh`.
 */
async function runSetCloudAccountToken(secrets: SecretManager, onChanged: () => void): Promise<void> {
  const accountLabel = await vscode.window.showInputBox({
    title: 'Copilot (Cloud): Set account token — account',
    prompt: 'Enter the GitHub account/username this token belongs to (must match a copilotCloud.accounts entry).',
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'Account label must not be empty.' : undefined),
  });
  if (accountLabel === undefined) {
    return; // cancelled
  }
  const label = accountLabel.trim();
  if (label.length === 0) {
    return;
  }

  const token = await vscode.window.showInputBox({
    title: `Copilot (Cloud): Set account token — ${label}`,
    prompt: `Paste the GitHub token for '${label}' (a gh OAuth token or a PAT with the “Agent tasks” read permission). Stored securely in VS Code SecretStorage.`,
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim().length === 0 ? 'Token must not be empty.' : undefined),
  });
  if (token === undefined) {
    return; // cancelled
  }
  const trimmed = token.trim();
  if (trimmed.length === 0) {
    return;
  }

  await secrets.setCloudAccountToken(label, trimmed);
  onChanged();
  // Confirmation MUST NOT echo the token.
  void vscode.window.showInformationMessage(
    `Agent Observability: token for '${label}' saved securely in VS Code SecretStorage. It is never uploaded or logged.`,
  );
}

/**
 * `toggleConsent` handler. Shows an explicit modal stating WHAT IS SHARED vs
 * WHAT IS NOT, then flips {@link ConsentManager} only if the user confirms.
 */
async function runToggleConsent(consent: ConsentManager): Promise<void> {
  const turningOn = !consent.isConsented();
  const confirmLabel = turningOn ? 'Enable sharing' : 'Disable sharing';

  const choice = await vscode.window.showInformationMessage(
    turningOn ? 'Enable cloud sharing?' : 'Disable cloud sharing?',
    { modal: true, detail: consentModalDetail(turningOn) },
    confirmLabel,
  );

  if (choice !== confirmLabel) {
    return; // cancelled — no change
  }

  await consent.setConsent(turningOn);
  void vscode.window.showInformationMessage(
    turningOn
      ? 'Agent Observability: cloud sharing is ON. Only aggregated, non-sensitive statistics will be shared.'
      : 'Agent Observability: cloud sharing is OFF. No aggregates will be uploaded.',
  );
}
