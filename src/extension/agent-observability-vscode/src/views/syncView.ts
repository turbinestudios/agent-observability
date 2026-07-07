import * as vscode from 'vscode';
import { Configuration } from '../config/configuration';
import { TelemetryService } from '../telemetry/telemetryService';
import { ConsentManager } from '../consent/consentManager';
import { SecretManager } from '../secrets/secretManager';
import { Commands } from '../commands';
import { isRepositoryIncluded } from '../aggregate/repoSyncPolicy';
import { WHAT_IS_SHARED, WHAT_IS_NOT_SHARED, DISCLOSURE_SUMMARY } from '../consent/consentDisclosure';
import { SyncStateStore, SyncRun, SyncRunOutcome } from '../sync/syncState';
import { CloudSink } from '../cloud/cloudSink';

/** Stable view id; referenced by package.json and the syncNow command wiring. */
export const SYNC_VIEW_ID = 'agentObservability.sync';

/**
 * Sync tree.
 *
 * Phase 4 surfaced the consent + API-key state and a shared-vs-not disclosure,
 * with inline command rows. Phase 7 extends it with the live sync picture: the
 * dashboard URL, whether background sync is on + its interval, the last sync time
 * and outcome, and the recent {@link SyncRun} history (most recent first). An
 * inline 'Sync Now' action runs the real upload. Refreshes on consent change,
 * configuration changes, and after every sync run.
 */
export class SyncViewProvider implements vscode.TreeDataProvider<SyncItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SyncItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private readonly config: Configuration,
    private readonly telemetry: TelemetryService,
    private readonly consent: ConsentManager,
    private readonly secrets: SecretManager,
    private readonly state: SyncStateStore,
    /** The Copilot (Cloud) sink, for the local-only disclosure + per-account status. */
    private readonly cloudSink?: CloudSink,
  ) {}

  /** Fired by the `agentObservability.syncNow` command, consent + config changes. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SyncItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SyncItem): vscode.ProviderResult<SyncItem[]> {
    if (element) {
      return [];
    }
    return this.getRootItems();
  }

  /**
   * Data seam. Surfaces consent + key state, the shared-vs-not disclosure, the
   * actionable command rows, current sync settings + background status, the last
   * sync time/outcome, and the recent run history. No network is performed here —
   * the run history is read from the persisted {@link SyncStateStore}.
   */
  private async getRootItems(): Promise<SyncItem[]> {
    const consented = this.consent.isConsented();
    const hasKey = await this.secrets.hasApiKey();
    const interval = this.config.getSyncIntervalMinutes();
    const dashboardUrl = this.config.getDashboardUrl();
    const backgroundOn = this.config.isSyncEnabled();
    const history = this.state.getHistory();
    const last = history[0];

    const items: SyncItem[] = [
      // Actionable Sync Now row (drives the real upload behind the gate).
      new SyncItem(
        'Sync Now',
        'Upload completed aggregate buckets now. Requires cloud sharing on and an API key. Nothing raw is ever sent.',
        new vscode.ThemeIcon('cloud-upload'),
        { command: Commands.syncNow, title: 'Sync Now' },
      ),
      // State rows.
      new SyncItem(
        `Cloud sharing: ${consented ? 'On' : 'Off'}`,
        consented
          ? 'You have opted in to share aggregated, non-sensitive statistics. Click to change.'
          : 'Sharing is off (default). No aggregates are uploaded. Click to enable.',
        new vscode.ThemeIcon(consented ? 'cloud' : 'circle-slash'),
        { command: Commands.toggleConsent, title: 'Toggle Cloud Sharing' },
      ),
      new SyncItem(
        `Organization API key: ${hasKey ? 'Set' : 'Not set'}`,
        hasKey
          ? 'An organization API key is stored securely in SecretStorage. Click to replace or clear it.'
          : "No API key set. Sync is blocked until a key is stored. Click to set one (format 'aoa_<keyId>_<secret>').",
        new vscode.ThemeIcon(hasKey ? 'key' : 'warning'),
        { command: Commands.setApiKey, title: 'Set Organization API Key' },
      ),
      // Background status + settings.
      new SyncItem(
        `Background sync: ${backgroundOn ? `On (every ${interval} min)` : 'Off'}`,
        backgroundOn
          ? 'Background sync periodically uploads completed aggregate buckets. Controlled by agentObservability.sync.enabled and sync.intervalMinutes (minimum 5). Still gated on consent + key.'
          : 'Background sync is off (default). Enable agentObservability.sync.enabled to upload periodically. Sync Now always works manually.',
        new vscode.ThemeIcon(backgroundOn ? 'sync' : 'sync-ignored'),
      ),
      // Repository scope (which repos are eligible to upload). Clickable → picker.
      this.syncScopeRow(),
      new SyncItem(
        `Dashboard URL: ${dashboardUrl}`,
        'Built-in cloud ingestion endpoint. Aggregates are delivered here when cloud sharing is on and an API key is set.',
        new vscode.ThemeIcon('link'),
      ),
      // Last sync row.
      this.lastSyncRow(last),
      // Disclosure rows (single-sourced copy).
      new SyncItem('What is shared', WHAT_IS_SHARED, new vscode.ThemeIcon('cloud-upload')),
      new SyncItem('What is NOT shared', WHAT_IS_NOT_SHARED, new vscode.ThemeIcon('shield')),
      // Actionable preview row.
      new SyncItem(
        'Preview aggregate payload',
        `Inspect locally what a batch would contain — nothing is uploaded. ${DISCLOSURE_SUMMARY}`,
        new vscode.ThemeIcon('eye'),
        { command: Commands.previewPayload, title: 'Preview Aggregate Payload' },
      ),
      // Local-data availability row.
      this.localDataRow(),
      // Copilot (Cloud): local-only disclosure + per-account auth status.
      ...this.cloudRows(),
    ];

    // Recent run history (most recent first), capped for readability.
    const recent = history.slice(0, 10);
    if (recent.length > 0) {
      for (const run of recent) {
        items.push(this.historyRow(run));
      }
    }

    return items;
  }

  /** A row summarizing the most recent sync attempt (or 'never synced'). */
  private lastSyncRow(last: SyncRun | undefined): SyncItem {
    if (last === undefined) {
      return new SyncItem(
        'Last sync: never',
        'No sync has run yet on this machine.',
        new vscode.ThemeIcon('history'),
      );
    }
    return new SyncItem(
      `Last sync: ${formatTime(last.startedAtMs)} — ${describeOutcome(last)}`,
      last.message ?? `Outcome: ${last.outcome}.`,
      new vscode.ThemeIcon(iconForOutcome(last.outcome)),
    );
  }

  /** One history row. */
  private historyRow(run: SyncRun): SyncItem {
    return new SyncItem(
      `${formatTime(run.startedAtMs)} — ${describeOutcome(run)}`,
      run.message ?? `Outcome: ${run.outcome}.`,
      new vscode.ThemeIcon(iconForOutcome(run.outcome)),
    );
  }

  /**
   * Repository scope row: how many of the locally-known repositories are
   * eligible to upload. Clickable to open the "Choose Repositories to Sync"
   * picker. Reads local telemetry only; nothing is uploaded.
   */
  private syncScopeRow(): SyncItem {
    const policy = this.config.getRepoSyncPolicy();
    const reposResult = this.telemetry.getDistinctRepositories();
    const repos = reposResult.ok ? reposResult.value : [];
    const command = { command: Commands.configureSyncRepositories, title: 'Choose Repositories to Sync' };

    if (policy.mode === 'all') {
      const label = repos.length > 0 ? `Sync scope: all repositories (${repos.length})` : 'Sync scope: all repositories';
      return new SyncItem(
        label,
        'Every repository in your local telemetry is eligible to upload (mode: all). Click to choose a subset. Cloud sync spans all repositories you use Copilot in, not just the open workspace.',
        new vscode.ThemeIcon('globe'),
        command,
      );
    }

    const includedCount = repos.filter((r) => isRepositoryIncluded(r, policy)).length;
    return new SyncItem(
      `Sync scope: ${includedCount} of ${repos.length} repositories`,
      `Only a subset of repositories is eligible to upload (mode: ${policy.mode}). Aggregates from the others stay local. Click to change the selection.`,
      new vscode.ThemeIcon('filter'),
      command,
    );
  }

  /** A read-only row reflecting whether local telemetry is available (no upload). */
  private localDataRow(): SyncItem {
    const result = this.telemetry.getOverview();
    if (result.ok) {
      return new SyncItem(
        `Local data available: ${result.value.totalInteractions} interactions`,
        'Local telemetry is readable. Only opt-in aggregates are ever uploaded; raw content stays on this machine.',
        new vscode.ThemeIcon('database'),
      );
    }
    return new SyncItem('Local data: unavailable', result.message, new vscode.ThemeIcon('circle-slash'));
  }

  /**
   * Copilot (Cloud) rows: a local-only disclosure (cloud sessions are pulled DOWN
   * but never uploaded) plus per-account auth status so an expired token surfaces
   * here without touching the aggregate path. Only shown when the source is on.
   */
  private cloudRows(): SyncItem[] {
    if (!this.config.isCopilotCloudEnabled()) {
      return [];
    }
    const rows: SyncItem[] = [
      new SyncItem(
        'Copilot (Cloud): local-only (never uploaded)',
        'Copilot cloud coding-agent sessions are pulled down to this machine and rendered locally. Their prompts, tool I/O, and assistant text are NEVER uploaded to the organization dashboard (org sharing for cloud sessions is a separate, future decision).',
        new vscode.ThemeIcon('shield'),
      ),
    ];
    const accounts = this.config.getCopilotCloudAccounts();
    const poller = this.cloudSink?.readIndex().poller;
    const statusByLogin = new Map((poller?.accounts ?? []).map((a) => [a.login, a]));
    if (accounts.length === 0) {
      rows.push(
        new SyncItem(
          'Cloud accounts: none pinned yet',
          'The active gh account is captured automatically on first enable; edit copilotCloud.accounts to poll more.',
          new vscode.ThemeIcon('account'),
        ),
      );
    }
    for (const login of accounts) {
      const status = statusByLogin.get(login);
      const outcome =
        status === undefined
          ? poller?.firstPollCompleted
            ? 'no data yet'
            : 'polling…'
          : status.lastOutcome === 'ok'
            ? 'ok'
            : status.lastOutcome;
      const healthy = outcome === 'ok' || outcome === 'polling…' || outcome === 'no data yet';
      rows.push(
        new SyncItem(
          `${login}: ${outcome}`,
          status?.lastErrorMessage ??
            'Per-account Copilot (Cloud) poll status. Set a token via “Copilot (Cloud): Set account token” if sign-in is required.',
          new vscode.ThemeIcon(healthy ? 'cloud' : 'warning'),
          healthy ? undefined : { command: Commands.setCloudAccountToken, title: 'Set account token' },
        ),
      );
    }
    return rows;
  }
}

/** Human label for a run outcome, including buckets on success. */
function describeOutcome(run: SyncRun): string {
  switch (run.outcome) {
    case 'success':
      return `uploaded ${run.bucketsSent} ${run.bucketsSent === 1 ? 'bucket' : 'buckets'}`;
    case 'upToDate':
      return 'up to date';
    case 'blocked':
      return 'blocked';
    case 'unauthorized':
      return 'unauthorized';
    case 'rejected':
      return 'rejected';
    case 'disabled':
      return 'server disabled';
    case 'serverError':
      return 'server error';
    case 'rateLimited':
      return 'rate limited';
    case 'network':
      return 'network error';
    case 'misconfigured':
      return 'not configured';
    default:
      return run.outcome;
  }
}

/** Theme icon id for an outcome. */
function iconForOutcome(outcome: SyncRunOutcome): string {
  switch (outcome) {
    case 'success':
      return 'pass';
    case 'upToDate':
      return 'check';
    case 'blocked':
    case 'misconfigured':
      return 'circle-slash';
    case 'unauthorized':
    case 'rejected':
      return 'error';
    default:
      return 'warning';
  }
}

/** Format an epoch-ms timestamp as a compact local date-time. */
function formatTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) {
    return 'unknown';
  }
  return new Date(epochMs).toLocaleString();
}

/** A single row in the Sync tree. Optionally invokes a command on click. */
export class SyncItem extends vscode.TreeItem {
  constructor(label: string, tooltip: string, icon: vscode.ThemeIcon, command?: vscode.Command) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.iconPath = icon;
    this.contextValue = 'agentObservability.syncItem';
    if (command !== undefined) {
      this.command = command;
    }
  }
}
