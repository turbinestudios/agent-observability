import * as vscode from 'vscode';
import { RepositorySummary, SessionSummary } from '../telemetry/models';
import { UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';
import { SessionDataSource, SourceRegistry } from '../sources/sessionSource';

/** Stable view id; referenced by package.json and the refresh command wiring. */
export const SESSIONS_VIEW_ID = 'agentObservability.sessions';

/**
 * Sessions tree.
 *
 * With more than one enabled source the tree is THREE levels —
 * source → repository → session — so Copilot and Claude Code activity sit under
 * their own top-level node (matching the unified-views design). With a single
 * enabled source the source level is elided (repository at the top), preserving
 * the original Copilot-only layout. Each session row carries its `sourceId` +
 * `sessionKey` so the detail / combined commands route to the right source. All
 * detail stays on-machine; non-ok results render a single explanatory row.
 */
export class SessionsViewProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private readonly sources: SourceRegistry) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SessionTreeItem): vscode.ProviderResult<SessionTreeItem[]> {
    if (element === undefined) {
      return this.getRoots();
    }
    if (element.kind === 'source' && element.sourceId !== undefined) {
      const source = this.sources.get(element.sourceId);
      return source !== undefined ? this.getRepositories(source) : [];
    }
    if (element.kind === 'repository' && element.sourceId !== undefined && element.repository !== undefined) {
      const source = this.sources.get(element.sourceId);
      return source !== undefined ? this.getSessions(source, element.repository) : [];
    }
    return [];
  }

  /** Top level: one node per enabled source, or repositories when only one. */
  private getRoots(): SessionTreeItem[] {
    const enabled = this.sources.enabled();
    if (enabled.length === 0) {
      return [infoItem('No telemetry sources enabled', 'Enable Copilot or Claude Code capture in settings.', 'circle-slash')];
    }
    if (enabled.length === 1) {
      return this.getRepositories(enabled[0]);
    }
    return enabled.map(sourceItem);
  }

  /** A source's repository groups + ungrouped sessions + any truncation notice. */
  private getRepositories(source: SessionDataSource): SessionTreeItem[] {
    const result = source.listRepositories();
    if (!result.ok) {
      return [explanatoryItem(result.reason, result.message)];
    }
    const ungrouped = source.listSessions(UNKNOWN_REPOSITORY);
    const ungroupedItems = ungrouped.ok ? ungrouped.value.map((s) => sessionItem(source.id, s)) : [];

    const items: SessionTreeItem[] = [];
    if (result.value.length === 0 && ungroupedItems.length === 0) {
      items.push(infoItem('No local sessions found', `No ${source.label} activity has been recorded yet.`));
    } else {
      items.push(...result.value.map((repo) => repositoryItem(source.id, repo)), ...ungroupedItems);
    }
    // Truncation is surfaced, never silent (Claude caps the most-recent set).
    const note = source.truncationNote?.();
    if (note !== undefined) {
      items.push(infoItem('More sessions not shown', note, 'list-filter'));
    }
    return items;
  }

  /** Children: sessions for one repository within a source. */
  private getSessions(source: SessionDataSource, repository: string): SessionTreeItem[] {
    const result = source.listSessions(repository);
    if (!result.ok) {
      return [explanatoryItem(result.reason, result.message)];
    }
    return result.value.map((s) => sessionItem(source.id, s));
  }
}

/** A collapsible source row (Copilot / Claude Code / Copilot Cloud). */
function sourceItem(source: SessionDataSource): SessionTreeItem {
  const item = new SessionTreeItem(source.label, vscode.TreeItemCollapsibleState.Expanded, 'source');
  item.sourceId = source.id;
  item.iconPath = new vscode.ThemeIcon(source.iconId);
  item.tooltip = `${source.label} agent sessions`;
  item.id = `source:${source.id}`;
  return item;
}

/** A collapsible repository row, scoped to a source. */
function repositoryItem(sourceId: string, repo: RepositorySummary): SessionTreeItem {
  const item = new SessionTreeItem(repo.repository, vscode.TreeItemCollapsibleState.Collapsed, 'repository');
  item.description = `${repo.sessionCount} session${repo.sessionCount === 1 ? '' : 's'}`;
  const models = repo.models.length > 0 ? repo.models.join(', ') : 'no models';
  item.tooltip = `${repo.repository}\n${repo.interactionCount} interactions · ${models}`;
  item.iconPath = new vscode.ThemeIcon('repo');
  item.repository = repo.repository;
  item.sourceId = sourceId;
  // Stable id incl. source so Copilot/Claude repo nodes never collide.
  item.id = `repo:${sourceId}:${repo.repository}`;
  return item;
}

/** A leaf session row carrying its source + key for detail/combined commands. */
function sessionItem(sourceId: string, session: SessionSummary): SessionTreeItem {
  const label = session.title !== undefined ? truncate(session.title, 60) : shortId(session.sessionId);
  const item = new SessionTreeItem(label, vscode.TreeItemCollapsibleState.None, 'session');
  const idHint = session.title !== undefined ? `${shortId(session.sessionId)} · ` : '';
  // A lifecycle badge (cloud agent: queued/in progress/waiting/failed/…) is
  // appended only when the source supplies one; local sessions leave it absent.
  const stateSuffix =
    session.stateLabel !== undefined && session.stateLabel.length > 0 ? ` · ${session.stateLabel}` : '';
  item.description = `${idHint}${session.interactionCount} call${session.interactionCount === 1 ? '' : 's'} · ${session.model}${stateSuffix}`;
  item.tooltip = sessionTooltip(session);
  item.iconPath = sessionStateIcon(session.stateLabel);
  item.sessionKey = session.sessionId;
  item.sourceId = sourceId;
  item.id = `session:${sourceId}:${session.sessionId}`;
  item.command = {
    command: 'agentObservability.openSession',
    title: 'Open Session Detail',
    arguments: [sourceId, session.sessionId],
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
  const stateLine = s.stateLabel !== undefined && s.stateLabel.length > 0 ? [`State: ${s.stateLabel}`] : [];
  return [
    ...titleLine,
    `Session ${s.sessionId}`,
    `Repository: ${s.repository}`,
    ...stateLine,
    `Started: ${start}`,
    `Duration: ${s.durationMs} ms`,
    `LLM calls: ${s.llmCalls} · Tool calls: ${s.toolCalls}`,
    `Tokens in/out: ${s.inputTokens} / ${s.outputTokens} (cached ${s.cachedTokens})`,
    `Modes: ${modes}`,
  ].join('\n');
}

/**
 * Pick a session-row icon from an optional lifecycle badge. Local sessions (no
 * `stateLabel`) keep the neutral chat icon; cloud sessions get a state-coloured
 * glyph (failed/timed-out in red, running/queued a spinner, waiting a question).
 */
function sessionStateIcon(stateLabel: string | undefined): vscode.ThemeIcon {
  if (stateLabel === undefined || stateLabel.length === 0) {
    return new vscode.ThemeIcon('comment-discussion');
  }
  const s = stateLabel.toLowerCase();
  if (s.includes('fail') || s.includes('timed') || s.includes('cancel')) {
    return new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red'));
  }
  if (s.includes('progress') || s.includes('running')) {
    return new vscode.ThemeIcon('sync~spin');
  }
  if (s.includes('queued')) {
    return new vscode.ThemeIcon('watch');
  }
  if (s.includes('waiting')) {
    return new vscode.ThemeIcon('question', new vscode.ThemeColor('charts.yellow'));
  }
  if (s.includes('complete')) {
    return new vscode.ThemeIcon('pass', new vscode.ThemeColor('charts.green'));
  }
  return new vscode.ThemeIcon('comment-discussion');
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
      return infoItem('Capture disabled', message, 'circle-slash');
    case 'missingDb':
      return infoItem('Telemetry source not found', message, 'database');
    case 'schemaMismatch':
      return infoItem('Unsupported telemetry schema', message, 'warning');
    case 'permission':
      return infoItem('Cannot read telemetry', message, 'lock');
    case 'cliMissing':
      return infoItem('GitHub CLI not found', message, 'terminal');
    case 'unauthenticated':
      return infoItem('Sign-in required', message, 'key');
    case 'featureUnavailable':
      return infoItem('Cloud agent unavailable', message, 'cloud');
    case 'rateLimited':
      return infoItem('Rate limited — retrying', message, 'clock');
    case 'network':
      return infoItem('Network unavailable', message, 'cloud-offline');
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

/** Node kind discriminator for the tree. */
export type SessionNodeKind = 'source' | 'repository' | 'session' | 'message';

/** A row in the Sessions tree. */
export class SessionTreeItem extends vscode.TreeItem {
  /** Set on source / repository / session rows. */
  sourceId?: string;
  /** Set on repository rows. */
  repository?: string;
  /** Set on session rows — the stable session key the detail command opens. */
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
