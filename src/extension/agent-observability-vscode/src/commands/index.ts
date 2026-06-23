import * as vscode from 'vscode';
import { CONFIG_SECTION } from '../config/configuration';
import { ConsentManager } from '../consent/consentManager';
import { consentModalDetail } from '../consent/consentDisclosure';
import { SecretManager } from '../secrets/secretManager';
import { SyncEngine } from '../sync/syncEngine';

/**
 * Stable command ids. These MUST match the `contributes.commands` entries in
 * package.json; later phases and menu `when` clauses reference these exact ids.
 */
export const Commands = {
  refresh: 'agentObservability.refresh',
  syncNow: 'agentObservability.syncNow',
  openSettings: 'agentObservability.openSettings',
  setApiKey: 'agentObservability.setApiKey',
  toggleConsent: 'agentObservability.toggleConsent',
  previewPayload: 'agentObservability.previewPayload',
  openSession: 'agentObservability.openSession',
  openCombinedSession: 'agentObservability.openCombinedSession',
  refreshSessionDetail: 'agentObservability.refreshSessionDetail',
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
  /** Open the LOCAL session-detail webview for a session key. */
  openSession: (sessionKey: string) => void;
  /** Open a single LOCAL combined-detail webview over several session keys. */
  openCombinedSession: (sessionKeys: string[]) => void;
  /** Re-fetch local telemetry and redraw the focused session-detail webview. */
  refreshSessionDetail: () => void;
  /** Open the LOCAL aggregate-payload preview (Phase 5 surfaces real content). */
  previewPayload: () => void;
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
  const { consent, secrets, syncEngine, openSession, openCombinedSession, refreshSessionDetail, previewPayload } =
    deps;

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
    void runSyncNow(syncEngine, () => refreshAll(refreshables));
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

  // Toggle Cloud Sharing — flip consent behind an explicit disclosure modal.
  register(Commands.toggleConsent, () => {
    void runToggleConsent(consent);
  });

  // Preview the outgoing aggregate payload (LOCAL only; nothing is uploaded).
  register(Commands.previewPayload, () => {
    previewPayload();
  });

  // Open Session Detail — invoked programmatically by a session TreeItem.
  // Opens the LOCAL drill-down webview; all session detail stays on-machine.
  register(Commands.openSession, (sessionKey?: unknown) => {
    if (typeof sessionKey === 'string' && sessionKey.length > 0) {
      openSession(sessionKey);
    }
  });

  // Open Combined Session Detail — invoked from the Sessions view context menu
  // when one or more session rows are selected. VS Code passes the focused node
  // first and the full multi-selection second; we combine the selected sessions
  // into a single LOCAL webview. All detail stays on-machine.
  register(Commands.openCombinedSession, (...args: unknown[]) => {
    const keys = sessionKeysFromCommandArgs(args);
    if (keys.length > 0) {
      openCombinedSession(keys);
    }
  });

  // Refresh Session Detail — title-bar button on the LOCAL session-detail webview
  // (single or combined). Re-snapshots local telemetry and redraws the focused
  // panel, the same fresh data a navigation click would load after a refresh.
  register(Commands.refreshSessionDetail, () => {
    refreshSessionDetail();
  });
}

/**
 * Extract session keys from a tree context-menu command invocation. VS Code
 * passes `(focusedNode, selectedNodes[])`; we prefer the multi-selection array
 * and fall back to the single focused node. Each node carries a `sessionKey`
 * string set by the Sessions view; anything without one is ignored.
 */
function sessionKeysFromCommandArgs(args: unknown[]): string[] {
  const selection = Array.isArray(args[1]) ? (args[1] as unknown[]) : [args[0]];
  const keys: string[] = [];
  for (const node of selection) {
    const key = (node as { sessionKey?: unknown } | undefined)?.sessionKey;
    if (typeof key === 'string' && key.length > 0) {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * `syncNow` handler. Runs the Phase 7 {@link SyncEngine} behind a progress
 * notification, then surfaces a clear result. The engine itself enforces the
 * consent + API-key gate (no network when closed) and never logs the key/body.
 * After the run the views are refreshed so the Sync history updates.
 */
async function runSyncNow(syncEngine: SyncEngine, onChanged: () => void): Promise<void> {
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Agent Observability: syncing aggregates…' },
    () => syncEngine.runSync({ manual: true }),
  );

  onChanged();

  switch (result.status) {
    case 'success':
      void vscode.window.showInformationMessage(
        `Agent Observability: uploaded ${result.bucketsSent} aggregate ${result.bucketsSent === 1 ? 'bucket' : 'buckets'}.`,
      );
      return;
    case 'upToDate':
      void vscode.window.showInformationMessage('Agent Observability: already up to date — nothing new to upload.');
      return;
    case 'blocked':
      void vscode.window.showInformationMessage(`Agent Observability: cannot sync — ${result.reason} Nothing was uploaded.`);
      return;
    case 'failed':
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
