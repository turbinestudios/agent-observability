import * as vscode from 'vscode';
import type { SessionSummary } from '../telemetry/models';
import type { ContextInsightCategory } from '../aggregate/contextInsightsModels';
import { hasMultipleRepositories, type ContextHotspot, type ContextHotspotSession } from '../aggregate/contextHotspotsIndex';
import type { ContextHotspotsProvider } from '../context/contextHotspotsProvider';

/** Stable view id; referenced by package.json and the refresh command wiring. */
export const CONTEXT_HOTSPOTS_VIEW_ID = 'agentObservability.contextHotspots';

/** The source id every hotspot session routes to (Copilot-only for now). */
const HOTSPOT_SOURCE_ID = 'copilot';

/**
 * Context Hotspots tree — the LOCAL twin of the dashboard's aggregate Context
 * Hotspots page. The cloud carries only per-file counts (session identities are
 * barred from upload), so this on-machine view exists to answer the one question
 * the dashboard cannot: WHICH of my sessions had this customization file in
 * context. Files sit at the top (busiest first); expanding one lists the
 * contributing sessions, each opening the LOCAL session-detail view (whose
 * Context Analysis tab — and the agent debug logs — is where the investigation
 * continues). All data stays on the machine.
 */
export class ContextHotspotsViewProvider implements vscode.TreeDataProvider<HotspotTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<HotspotTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly provider: ContextHotspotsProvider) {}

  refresh(): void {
    this.provider.refresh();
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: HotspotTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: HotspotTreeItem): vscode.ProviderResult<HotspotTreeItem[]> {
    if (element === undefined) {
      return this.getRoots();
    }
    if (element.kind === 'file' && element.hotspot !== undefined) {
      return element.hotspot.sessions.map((s) => sessionItem(s, this.provider.describeSession(s.sessionKey)));
    }
    return [];
  }

  /** Top level: one node per hotspot file (busiest first), or an explanatory row. */
  private getRoots(): HotspotTreeItem[] {
    if (!this.provider.isEnabled()) {
      return [infoItem('Copilot capture disabled', 'Enable Copilot telemetry capture in settings to see context hotspots.', 'circle-slash')];
    }
    const result = this.provider.getHotspots();
    if (!result.ok) {
      return [explanatoryItem(result.reason, result.message)];
    }
    if (result.value.length === 0) {
      return [infoItem('No context hotspots found', 'No customization files were detected in recent sessions. Open the workspace whose sessions you want to inspect, then refresh.', 'info')];
    }
    const showRepo = hasMultipleRepositories(result.value);
    return result.value.map((h) => fileItem(h, showRepo));
  }
}

/** Icon for a customization category. */
function iconForCategory(category: ContextInsightCategory): string {
  switch (category) {
    case 'instruction':
      return 'book';
    case 'skill':
      return 'lightbulb';
    case 'agent':
      return 'hubot';
    case 'hook':
      return 'plug';
    case 'prompt':
      return 'comment';
    default:
      return 'file';
  }
}

/** A top-level customization-file row with its contributing-session count. */
function fileItem(hotspot: ContextHotspot, showRepo: boolean): HotspotTreeItem {
  const item = new HotspotTreeItem(hotspot.contextFile, vscode.TreeItemCollapsibleState.Collapsed, 'file');
  const count = hotspot.sessions.length;
  const repoPrefix = showRepo ? `${shortRepo(hotspot.repository)} · ` : '';
  item.description = `${repoPrefix}${count} session${count === 1 ? '' : 's'} · ~${hotspot.estTokensMax} tok`;
  item.tooltip = [
    hotspot.contextFile,
    `Repository: ${hotspot.repository}`,
    `Category: ${hotspot.category}`,
    `Sessions: ${count} (applied in ${hotspot.appliedCount})`,
    `Est. token weight (max): ${hotspot.estTokensMax}`,
  ].join('\n');
  item.iconPath = new vscode.ThemeIcon(iconForCategory(hotspot.category));
  item.hotspot = hotspot;
  item.id = `hotspot:${hotspot.repository}:${hotspot.contextFile}`;
  return item;
}

/** A leaf session row that opens the LOCAL session-detail view when clicked. */
function sessionItem(session: ContextHotspotSession, summary: SessionSummary | undefined): HotspotTreeItem {
  const label = summary?.title !== undefined ? truncate(summary.title, 60) : shortId(session.sessionKey);
  const item = new HotspotTreeItem(label, vscode.TreeItemCollapsibleState.None, 'session');
  const idHint = summary?.title !== undefined ? `${shortId(session.sessionKey)} · ` : '';
  const model = summary?.model !== undefined ? ` · ${summary.model}` : '';
  item.description = `${idHint}${new Date(session.startTimeMs).toLocaleString()}${model}`;
  item.tooltip = [
    `Session ${session.sessionKey}`,
    `Started: ${new Date(session.startTimeMs).toISOString()}`,
    session.applied ? 'File was applied (in context envelope)' : 'File was discovered but skipped',
    session.hadError ? 'Session had an error' : undefined,
    session.hadDeviation ? 'Session had a workflow deviation' : undefined,
  ].filter((l): l is string => l !== undefined).join('\n');
  item.iconPath = new vscode.ThemeIcon('comment-discussion');
  item.id = `hotspot-session:${session.sessionKey}`;
  item.command = {
    command: 'agentObservability.openSession',
    title: 'Open Session Detail',
    arguments: [HOTSPOT_SOURCE_ID, session.sessionKey],
  };
  return item;
}

/** A `owner/name` short label for a repository URL, else the raw value. */
function shortRepo(repository: string): string {
  const match = /https?:\/\/[^/]+\/(.+?)(?:\.git)?$/.exec(repository);
  return match !== null ? match[1] : repository;
}

/** Short, human-friendly session id (first segment of a UUID, else truncated). */
function shortId(sessionId: string): string {
  const dash = sessionId.indexOf('-');
  if (dash > 0) {
    return sessionId.slice(0, dash);
  }
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
}

/** Collapse whitespace and truncate a label to `max` chars with an ellipsis. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
}

/** Map a failure reason to a single explanatory tree row. */
function explanatoryItem(reason: string, message: string): HotspotTreeItem {
  switch (reason) {
    case 'disabled':
      return infoItem('Capture disabled', message, 'circle-slash');
    case 'missingDb':
      return infoItem('Telemetry source not found', message, 'database');
    case 'schemaMismatch':
      return infoItem('Unsupported telemetry schema', message, 'warning');
    case 'permission':
      return infoItem('Cannot read telemetry', message, 'lock');
    default:
      return infoItem('Context hotspots unavailable', message, 'error');
  }
}

function infoItem(label: string, tooltip: string, icon = 'info'): HotspotTreeItem {
  const item = new HotspotTreeItem(label, vscode.TreeItemCollapsibleState.None, 'message');
  item.tooltip = tooltip;
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

/** Node kind discriminator for the tree. */
export type HotspotNodeKind = 'file' | 'session' | 'message';

/** A row in the Context Hotspots tree. */
export class HotspotTreeItem extends vscode.TreeItem {
  /** Set on file rows: the full hotspot (carries its contributing sessions). */
  hotspot?: ContextHotspot;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly kind: HotspotNodeKind,
  ) {
    super(label, collapsibleState);
  }
}
