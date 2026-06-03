import * as vscode from 'vscode';
import { TelemetryService } from '../telemetry/telemetryService';
import { OverviewMetrics } from '../telemetry/models';

/** Stable view id; referenced by package.json and the refresh command wiring. */
export const OVERVIEW_VIEW_ID = 'agentObservability.overview';

/**
 * Local Overview tree.
 *
 * Phase 2: renders {@link OverviewMetrics} read from the local Copilot SQLite
 * DB (via {@link TelemetryService}) as flat metric rows. On any non-ok result
 * (disabled, missing DB, schema mismatch, permission, error) it shows a single
 * explanatory row instead of failing. The refresh seam is unchanged.
 */
export class OverviewViewProvider implements vscode.TreeDataProvider<OverviewItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<OverviewItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly telemetry: TelemetryService) {}

  /** Fired by the `agentObservability.refresh` command to re-render the view. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: OverviewItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: OverviewItem): vscode.ProviderResult<OverviewItem[]> {
    if (element) {
      return [];
    }
    return this.getRootItems();
  }

  /** Data seam: compute the top-level metric rows from local telemetry. */
  private getRootItems(): OverviewItem[] {
    const result = this.telemetry.getOverview();
    if (!result.ok) {
      return [explanatoryItem(result.reason, result.message)];
    }
    return metricRows(result.value);
  }
}

/** Build the metric rows for an overview. */
function metricRows(m: OverviewMetrics): OverviewItem[] {
  return [
    new OverviewItem(`Interactions: ${m.totalInteractions}`, 'Total spans observed locally.', 'pulse'),
    new OverviewItem(`Sessions: ${m.totalSessions}`, 'Distinct Copilot sessions.', 'comment-discussion'),
    new OverviewItem(
      `Repositories: ${m.totalRepositories}`,
      'Distinct sanitized repositories (incl. "unknown").',
      'repo',
    ),
    new OverviewItem(`Models: ${m.totalModels}`, 'Distinct models seen.', 'chip'),
    new OverviewItem(`Avg latency: ${m.avgDurationMs} ms`, 'Mean span duration.', 'watch'),
    new OverviewItem(
      `Tokens in/out: ${m.inputTokens} / ${m.outputTokens}`,
      `Cached: ${m.cachedTokens}. Token sums count chat spans only.`,
      'symbol-numeric',
    ),
    new OverviewItem(`Errors: ${m.errorCount}`, 'Spans with status_code = 2 (error).', 'error'),
  ];
}

/** Map a failure reason to a single explanatory tree row. */
function explanatoryItem(reason: string, message: string): OverviewItem {
  switch (reason) {
    case 'disabled':
      return new OverviewItem('Local telemetry disabled', message, 'circle-slash');
    case 'missingDb':
      return new OverviewItem('Copilot telemetry DB not found', message, 'database');
    case 'schemaMismatch':
      return new OverviewItem('Unsupported telemetry schema', message, 'warning');
    case 'permission':
      return new OverviewItem('Cannot read telemetry DB', message, 'lock');
    default:
      return new OverviewItem('Telemetry unavailable', message, 'error');
  }
}

/** A single row in the Local Overview tree. */
export class OverviewItem extends vscode.TreeItem {
  constructor(label: string, tooltip: string, icon: string) {
    super(label, vscode.TreeItemCollapsibleState.None);
    this.tooltip = tooltip;
    this.iconPath = new vscode.ThemeIcon(icon);
    this.contextValue = 'agentObservability.overviewItem';
  }
}
