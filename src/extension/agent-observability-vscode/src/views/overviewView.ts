import * as vscode from 'vscode';
import { OverviewMetrics } from '../telemetry/models';
import { SessionDataSource, SourceRegistry } from '../sources/sessionSource';

/** Stable view id; referenced by package.json and the refresh command wiring. */
export const OVERVIEW_VIEW_ID = 'agentObservability.overview';

/**
 * Local Overview tree.
 *
 * Renders MERGED {@link OverviewMetrics} summed across every enabled source
 * (Copilot + Claude Code), followed by a one-line per-source breakdown so each
 * source's contribution stays visible. Counts that are set-valued across sources
 * (repositories / models) are summed — a small over-count when the same repo or
 * model appears in both sources is accepted for this glance-level view. On a
 * total failure it shows a single explanatory row.
 */
export class OverviewViewProvider implements vscode.TreeDataProvider<OverviewItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<OverviewItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sources: SourceRegistry) {}

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

  private getRootItems(): OverviewItem[] {
    const enabled = this.sources.enabled();
    if (enabled.length === 0) {
      return [new OverviewItem('No telemetry sources enabled', 'Enable Copilot or Claude Code capture in settings.', 'circle-slash')];
    }

    const perSource: Array<{ source: SessionDataSource; metrics: OverviewMetrics }> = [];
    let firstFailure: { reason: string; message: string } | undefined;
    for (const source of enabled) {
      const result = source.getOverview();
      if (result.ok) {
        perSource.push({ source, metrics: result.value });
      } else if (firstFailure === undefined) {
        firstFailure = { reason: result.reason, message: result.message };
      }
    }

    if (perSource.length === 0) {
      return [explanatoryItem(firstFailure?.reason ?? 'error', firstFailure?.message ?? 'No telemetry available.')];
    }

    const merged = mergeMetrics(perSource.map((p) => p.metrics));
    const rows = metricRows(merged);
    // Per-source breakdown — only meaningful when more than one source has data.
    if (perSource.length > 1) {
      for (const { source, metrics } of perSource) {
        rows.push(
          new OverviewItem(
            `${source.label}: ${metrics.totalSessions} session${metrics.totalSessions === 1 ? '' : 's'}`,
            `${metrics.totalInteractions} interactions · tokens ${metrics.inputTokens}/${metrics.outputTokens} (cached ${metrics.cachedTokens})`,
            source.iconId,
          ),
        );
      }
    }
    return rows;
  }
}

/** Sum metrics across sources (see class note on the repo/model over-count). */
function mergeMetrics(all: OverviewMetrics[]): OverviewMetrics {
  const merged: OverviewMetrics = {
    totalInteractions: 0,
    totalSessions: 0,
    totalRepositories: 0,
    totalModels: 0,
    avgDurationMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    errorCount: 0,
  };
  let weightedDuration = 0;
  for (const m of all) {
    merged.totalInteractions += m.totalInteractions;
    merged.totalSessions += m.totalSessions;
    merged.totalRepositories += m.totalRepositories;
    merged.totalModels += m.totalModels;
    merged.inputTokens += m.inputTokens;
    merged.outputTokens += m.outputTokens;
    merged.cachedTokens += m.cachedTokens;
    merged.errorCount += m.errorCount;
    weightedDuration += m.avgDurationMs * m.totalInteractions;
  }
  merged.avgDurationMs =
    merged.totalInteractions > 0 ? Math.round(weightedDuration / merged.totalInteractions) : 0;
  return merged;
}

/** Build the merged metric rows. */
function metricRows(m: OverviewMetrics): OverviewItem[] {
  return [
    new OverviewItem(`Interactions: ${m.totalInteractions}`, 'Total interactions observed locally across sources.', 'pulse'),
    new OverviewItem(`Sessions: ${m.totalSessions}`, 'Distinct agent sessions across sources.', 'comment-discussion'),
    new OverviewItem(`Repositories: ${m.totalRepositories}`, 'Distinct sanitized repositories (summed per source; incl. "unknown").', 'repo'),
    new OverviewItem(`Models: ${m.totalModels}`, 'Distinct models seen (summed per source).', 'chip'),
    new OverviewItem(`Avg latency: ${m.avgDurationMs} ms`, 'Interaction-weighted mean duration.', 'watch'),
    new OverviewItem(
      `Tokens in/out: ${m.inputTokens} / ${m.outputTokens}`,
      `Cached: ${m.cachedTokens}.`,
      'symbol-numeric',
    ),
    new OverviewItem(`Errors: ${m.errorCount}`, 'Failed interactions across sources.', 'error'),
  ];
}

/** Map a failure reason to a single explanatory tree row. */
function explanatoryItem(reason: string, message: string): OverviewItem {
  switch (reason) {
    case 'disabled':
      return new OverviewItem('Telemetry disabled', message, 'circle-slash');
    case 'missingDb':
      return new OverviewItem('Telemetry source not found', message, 'database');
    case 'schemaMismatch':
      return new OverviewItem('Unsupported telemetry schema', message, 'warning');
    case 'permission':
      return new OverviewItem('Cannot read telemetry', message, 'lock');
    case 'cliMissing':
      return new OverviewItem('GitHub CLI not found', message, 'terminal');
    case 'unauthenticated':
      return new OverviewItem('Sign-in required', message, 'key');
    case 'featureUnavailable':
      return new OverviewItem('Cloud agent unavailable', message, 'cloud');
    case 'rateLimited':
      return new OverviewItem('Rate limited — retrying', message, 'clock');
    case 'network':
      return new OverviewItem('Network unavailable', message, 'cloud-offline');
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
