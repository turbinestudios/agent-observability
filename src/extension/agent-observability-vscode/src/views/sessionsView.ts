import * as vscode from 'vscode';
import { TelemetryService } from '../telemetry/telemetryService';
import { RepositorySummary, SessionSummary } from '../telemetry/models';
import { UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';

/** Stable view id; referenced by package.json and the refresh command wiring. */
export const SESSIONS_VIEW_ID = 'agentObservability.sessions';

/**
 * Sessions tree (two levels).
 *
 * Phase 2: top level = one {@link RepositorySummary} per sanitized repository;
 * expanding a repository yields its {@link SessionSummary} children. Each
 * session row stores a stable session-key id (`sessionKey` on the item) so the
 * Phase 3 detail command can open it. All detail stays on-machine. Non-ok
 * results render a single explanatory row.
 */
export class SessionsViewProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly telemetry: TelemetryService) {}

  /** Fired by the `agentObservability.refresh` command to re-render the view. */
  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeItem): vscode.ProviderResult<SessionTreeItem[]> {
    if (element === undefined) {
      return this.getRepositories();
    }
    if (element.kind === 'repository' && element.repository !== undefined) {
      return this.getSessions(element.repository);
    }
    // Session rows are leaves (Phase 3 opens detail via a command, not children).
    return [];
  }

  /** Top level: repository groups + ungrouped sessions (no repo). */
  private getRepositories(): SessionTreeItem[] {
    const result = this.telemetry.listRepositories();
    if (!result.ok) {
      return [explanatoryItem(result.reason, result.message)];
    }

    // Ungrouped sessions: human-initiated but no repo identified.
    const ungrouped = this.telemetry.listSessions(UNKNOWN_REPOSITORY);
    const ungroupedItems = ungrouped.ok ? ungrouped.value.map(sessionItem) : [];

    if (result.value.length === 0 && ungroupedItems.length === 0) {
      return [infoItem('No local sessions found', 'No Copilot telemetry has been recorded yet.')];
    }

    const repoItems = result.value.map(repositoryItem);
    return [...repoItems, ...ungroupedItems];
  }

  /** Children: sessions for one repository. */
  private getSessions(repository: string): SessionTreeItem[] {
    const result = this.telemetry.listSessions(repository);
    if (!result.ok) {
      return [explanatoryItem(result.reason, result.message)];
    }
    return result.value.map(sessionItem);
  }
}

/** Build a collapsible repository row. */
function repositoryItem(repo: RepositorySummary): SessionTreeItem {
  const item = new SessionTreeItem(
    repo.repository,
    vscode.TreeItemCollapsibleState.Collapsed,
    'repository',
  );
  item.description = `${repo.sessionCount} session${repo.sessionCount === 1 ? '' : 's'}`;
  const models = repo.models.length > 0 ? repo.models.join(', ') : 'no models';
  item.tooltip = `${repo.repository}\n${repo.interactionCount} interactions · ${models}`;
  item.iconPath = new vscode.ThemeIcon('repo');
  item.repository = repo.repository;
  return item;
}

/** Build a leaf session row carrying a stable session-key id for Phase 3. */
function sessionItem(session: SessionSummary): SessionTreeItem {
  // Prefer Copilot's session name; fall back to the short id when none exists.
  const label =
    session.title !== undefined ? truncate(session.title, 60) : shortId(session.sessionId);
  const item = new SessionTreeItem(label, vscode.TreeItemCollapsibleState.None, 'session');
  // When a title labels the row, surface the short id in the description so the
  // session is still identifiable at a glance.
  const idHint = session.title !== undefined ? `${shortId(session.sessionId)} · ` : '';
  item.description = `${idHint}${session.interactionCount} call${session.interactionCount === 1 ? '' : 's'} · ${session.model}`;
  item.tooltip = sessionTooltip(session);
  item.iconPath = new vscode.ThemeIcon('comment-discussion');
  item.sessionKey = session.sessionId;
  // Stable id for tree-state + Phase 3 reveal/open.
  item.id = `session:${session.sessionId}`;
  // Clicking the row opens the local session-detail webview (Phase 3).
  item.command = {
    command: 'agentObservability.openSession',
    title: 'Open Session Detail',
    arguments: [session.sessionId],
  };
  return item;
}

function sessionTooltip(s: SessionSummary): string {
  const start = new Date(s.startedAtMs).toISOString();
  const modes = s.agentModes.join(', ');
  const titleLine =
    s.title !== undefined
      ? [s.titleDerived === true ? `Title (from first message): ${s.title}` : `Title: ${s.title}`]
      : [];
  return [
    ...titleLine,
    `Session ${s.sessionId}`,
    `Repository: ${s.repository}`,
    `Started: ${start}`,
    `Duration: ${s.durationMs} ms`,
    `LLM calls: ${s.llmCalls} · Tool calls: ${s.toolCalls}`,
    `Tokens in/out: ${s.inputTokens} / ${s.outputTokens} (cached ${s.cachedTokens})`,
    `Modes: ${modes}`,
  ].join('\n');
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
function explanatoryItem(reason: string, message: string): SessionTreeItem {
  switch (reason) {
    case 'disabled':
      return infoItem('Local telemetry disabled', message, 'circle-slash');
    case 'missingDb':
      return infoItem('Copilot telemetry DB not found', message, 'database');
    case 'schemaMismatch':
      return infoItem('Unsupported telemetry schema', message, 'warning');
    case 'permission':
      return infoItem('Cannot read telemetry DB', message, 'lock');
    default:
      return infoItem('Sessions unavailable', message, 'error');
  }
}

function infoItem(label: string, tooltip: string, icon = 'info'): SessionTreeItem {
  const item = new SessionTreeItem(label, vscode.TreeItemCollapsibleState.None, 'message');
  item.tooltip = tooltip;
  item.iconPath = new vscode.ThemeIcon(icon);
  return item;
}

/** Node kind discriminator for the two-level tree. */
export type SessionNodeKind = 'repository' | 'session' | 'message';

/** A row in the Sessions tree (repository, session leaf, or message). */
export class SessionTreeItem extends vscode.TreeItem {
  /** Set on repository rows. */
  repository?: string;
  /** Set on session rows — the stable session key Phase 3 opens. */
  sessionKey?: string;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    readonly kind: SessionNodeKind,
  ) {
    super(label, collapsibleState);
    this.contextValue = `agentObservability.${kind}Item`;
  }
}
