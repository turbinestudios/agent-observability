import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { LocalDeviationDetector } from '@agent-observability/core/src/deviation/localDeviations';
import { WorkflowDeviation } from '@agent-observability/core/src/deviation/models';
import { groupInteractionsByTurn } from '@agent-observability/core/src/deviation/turnGrouping';
import { SessionDetail } from '@agent-observability/core/src/telemetry/models';
import { SessionDataSource, SourceRegistry } from '@agent-observability/core/src/sources/sessionSource';
import { combineSessionDetails } from '@agent-observability/core/src/telemetry/combinedSessionDetail';
import { AcceptedMissingConfig } from '@agent-observability/core/src/context/contextAnalyzer';
import {
  CombinedSessionSection,
  CostMode,
  RepositoryDetailSection,
  RepositoryDetailView,
  repoShortName,
  renderCombinedSessionDetailHtml,
  renderCombinedSessionDetailContent,
  renderRepositoryDetailHtml,
  renderRepositoryDetailContent,
  renderSessionDetailHtml,
  renderSessionDetailContent,
} from '@agent-observability/core/src/views/sessionDetailHtml';

/** Webview view type used for all session-detail panels. */
const VIEW_TYPE = 'agentObservability.sessionDetail';

/** A session addressed by its source + key. */
export interface SourceSession {
  sourceId: string;
  sessionKey: string;
}

/** A repository addressed by its source + sanitized repository name. */
export interface SourceRepository {
  sourceId: string;
  repository: string;
}

/**
 * Manages the local session-detail webview panels across BOTH sources.
 *
 * A panel is keyed by `${sourceId}::${sessionKey}` (combined panels by their
 * sorted key set) so a Copilot and a Claude session that happen to share an id
 * never collide. The detail body is rendered from whichever
 * {@link SessionDataSource} owns the session; Copilot sessions additionally get
 * the context-analysis pass and workflow content predicates (which read
 * Copilot-only span attributes via the concrete {@link TelemetryService}), while
 * Claude sessions run the per-turn deviation checks over metadata and skip
 * context analysis. The cost basis (AIU vs token-priced USD) follows the source.
 */
export class SessionDetailPanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly rerenderers = new Map<vscode.WebviewPanel, () => void>();
  /**
   * Panels whose live document shell is already mounted. The FIRST render of a
   * panel sets `webview.html` (the full document + the in-page controller); every
   * later render posts an `update` message carrying just the body, so the controller
   * swaps it in WITHOUT reloading — preserving open collapsibles, the active tab,
   * and scroll. A panel reverts to "not mounted" if it falls back to a message doc
   * (see {@link renderMessage}), so the next good render rebuilds the shell.
   */
  private readonly mounted = new WeakSet<vscode.WebviewPanel>();
  private activePanel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly sources: SourceRegistry,
    private readonly deviations: LocalDeviationDetector,
  ) {}

  /** Open (or reveal) the detail panel for a source's session key. */
  open(sourceId: string, sessionKey: string): void {
    if (sessionKey.length === 0) {
      return;
    }
    const panelKey = `${sourceId}::${sessionKey}`;
    const existing = this.panels.get(panelKey);
    if (existing !== undefined) {
      existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active);
      this.render(existing, sourceId, sessionKey);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Session ${shortLabel(sessionKey)}`,
      vscode.ViewColumn.Active,
      // Retain context when hidden so live updates (posted as `update` messages,
      // not via `webview.html`) survive the panel being tabbed away and back —
      // otherwise VS Code would reload the shell to its initial, pre-update state.
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panels.set(panelKey, panel);
    this.rerenderers.set(panel, () => this.render(panel, sourceId, sessionKey));
    this.trackActive(panel);
    panel.onDidDispose(() => {
      this.panels.delete(panelKey);
      this.forget(panel);
    });
    this.registerMessageHandler(panel, sourceId, sessionKey);

    this.render(panel, sourceId, sessionKey);
  }

  /**
   * Open (or reveal) a SINGLE combined panel for several sessions. Selections
   * spanning sources are narrowed to the FIRST source present (a combined card
   * mixes one cost basis); a selection of one falls back to the single view.
   */
  openCombined(sessions: readonly SourceSession[]): void {
    const cleaned = sessions.filter((s) => s.sessionKey.length > 0);
    if (cleaned.length === 0) {
      return;
    }
    const sourceId = cleaned[0].sourceId;
    const keys = [...new Set(cleaned.filter((s) => s.sourceId === sourceId).map((s) => s.sessionKey))].sort();
    // A combined card uses one cost basis, so a cross-source selection is narrowed
    // to the first source — surfaced, not silent (mirrors the tree's truncation row).
    const dropped = cleaned.filter((s) => s.sourceId !== sourceId).length;
    if (dropped > 0) {
      const label = this.sources.get(sourceId)?.label ?? sourceId;
      void vscode.window.showInformationMessage(
        `Agent Observability: combined the ${label} sessions; ${dropped} session(s) from other sources were not combined (a combined view uses a single cost basis).`,
      );
    }
    if (keys.length === 1) {
      this.open(sourceId, keys[0]);
      return;
    }

    const panelKey = `combined:${sourceId}:${keys.join('|')}`;
    const existing = this.panels.get(panelKey);
    if (existing !== undefined) {
      existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active);
      this.renderCombined(existing, sourceId, keys);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Combined sessions (${keys.length})`,
      vscode.ViewColumn.Active,
      // See the single-session panel: retained so live `update` messages survive
      // the panel being hidden and re-shown.
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = new vscode.ThemeIcon('layers');
    this.panels.set(panelKey, panel);
    this.rerenderers.set(panel, () => this.renderCombined(panel, sourceId, keys));
    this.trackActive(panel);
    panel.onDidDispose(() => {
      this.panels.delete(panelKey);
      this.forget(panel);
    });

    this.renderCombined(panel, sourceId, keys);
  }

  /**
   * Open (or reveal) a repository-detail panel: aggregate totals over EVERY
   * session of one or more repositories. Selections spanning sources are narrowed
   * to the FIRST source present (one cost basis per card, like
   * {@link openCombined}). Both sources list only root sessions (Claude folds
   * sub-agent transcripts into their parent; Copilot lists human-initiated UUID
   * roots only), so a repo-wide merge sums each agent tree exactly once — up to
   * the rare same-tree overlap documented on
   * {@link combineSessionDetails combineSessionDetails' caveat}.
   */
  openRepository(repos: readonly SourceRepository[]): void {
    const cleaned = repos.filter((r) => r.repository.length > 0);
    if (cleaned.length === 0) {
      return;
    }
    const sourceId = cleaned[0].sourceId;
    const names = [...new Set(cleaned.filter((r) => r.sourceId === sourceId).map((r) => r.repository))].sort();
    const dropped = cleaned.filter((r) => r.sourceId !== sourceId).length;
    if (dropped > 0) {
      const label = this.sources.get(sourceId)?.label ?? sourceId;
      void vscode.window.showInformationMessage(
        `Agent Observability: combined the ${label} repositories; ${dropped} repository(ies) from other sources were not combined (a combined view uses a single cost basis).`,
      );
    }

    const panelKey = `repo:${sourceId}:${names.join('|')}`;
    const existing = this.panels.get(panelKey);
    if (existing !== undefined) {
      existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active);
      this.renderRepository(existing, sourceId, names);
      return;
    }

    const title =
      names.length === 1 ? `Repository ${repoShortName(names[0])}` : `Combined repositories (${names.length})`;
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      title,
      vscode.ViewColumn.Active,
      // See the single-session panel: retained so live `update` messages survive
      // the panel being hidden and re-shown.
      { enableScripts: true, retainContextWhenHidden: true },
    );
    panel.iconPath = new vscode.ThemeIcon('repo');
    this.panels.set(panelKey, panel);
    this.rerenderers.set(panel, () => this.renderRepository(panel, sourceId, names));
    this.trackActive(panel);
    panel.onDidDispose(() => {
      this.panels.delete(panelKey);
      this.forget(panel);
    });

    this.renderRepository(panel, sourceId, names);
  }

  /**
   * Re-read fresh telemetry from every source and redraw the focused detail
   * panel — the title-bar Refresh button. Works for both the single and combined
   * views; a no-op when no detail panel is focused.
   */
  refreshActive(): void {
    const panel = this.activePanel;
    if (panel === undefined) {
      return;
    }
    this.sources.refresh();
    this.rerenderers.get(panel)?.();
  }

  /**
   * Re-render the focused detail panel WITHOUT re-reading every source. Used by
   * the live-update path, where the caller has already done the cheap, targeted
   * source invalidation (drop the Copilot snapshot + the Claude discovery listing)
   * so a full {@link SourceRegistry.refresh} would needlessly re-snapshot/re-parse.
   * A no-op when no detail panel is focused.
   */
  rerenderActive(): void {
    const panel = this.activePanel;
    if (panel === undefined) {
      return;
    }
    this.rerenderers.get(panel)?.();
  }

  /** Track which detail panel is focused so {@link refreshActive} can find it. */
  private trackActive(panel: vscode.WebviewPanel): void {
    if (panel.active) {
      this.activePanel = panel;
    }
    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        this.activePanel = e.webviewPanel;
      } else if (this.activePanel === e.webviewPanel) {
        this.activePanel = undefined;
      }
    });
  }

  /** Drop a disposed panel from the rerender registry and active-panel slot. */
  private forget(panel: vscode.WebviewPanel): void {
    this.rerenderers.delete(panel);
    this.mounted.delete(panel);
    if (this.activePanel === panel) {
      this.activePanel = undefined;
    }
  }

  /** Dispose every open panel (extension deactivate). */
  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.rerenderers.clear();
    this.activePanel = undefined;
  }

  /**
   * Register a message handler for webview → extension messages: accept-missing
   * actions (update the workspace configuration and re-render) and
   * open-context-file links (open the file in an editor).
   */
  private registerMessageHandler(panel: vscode.WebviewPanel, sourceId: string, sessionKey: string): void {
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const message = msg as { type?: string; file?: string; source?: string; path?: string };
      const config = vscode.workspace.getConfiguration('agentObservability.context');

      if (message.type === 'open-context-file' && typeof message.path === 'string') {
        try {
          const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(message.path));
          await vscode.window.showTextDocument(doc, { preview: true });
        } catch {
          void vscode.window.showWarningMessage(
            `Agent Observability: could not open "${message.path}" — the file may have been moved or deleted.`,
          );
        }
      } else if (message.type === 'accept-missing-file' && typeof message.file === 'string') {
        const current: string[] = config.get('acceptedMissingFiles', []);
        if (!current.includes(message.file)) {
          await config.update('acceptedMissingFiles', [...current, message.file], vscode.ConfigurationTarget.Workspace);
        }
        this.render(panel, sourceId, sessionKey);
      } else if (message.type === 'accept-missing-source' && typeof message.source === 'string') {
        const current: string[] = config.get('acceptedMissingSources', []);
        if (!current.includes(message.source)) {
          await config.update('acceptedMissingSources', [...current, message.source], vscode.ConfigurationTarget.Workspace);
        }
        this.render(panel, sourceId, sessionKey);
      }
    });
  }

  /** Read the accepted-missing configuration from workspace settings. */
  private readAcceptedMissing(): AcceptedMissingConfig {
    const config = vscode.workspace.getConfiguration('agentObservability.context');
    return {
      files: config.get<string[]>('acceptedMissingFiles', []),
      sources: config.get<string[]>('acceptedMissingSources', []),
    };
  }

  /**
   * Render (or live-update) the single-session detail. The FIRST render of a panel
   * mounts the full document; later renders post the body as an `update` message so
   * the in-page controller swaps it in without reloading — preserving the open
   * collapsibles, active tab, and scroll the user has set.
   */
  private render(panel: vscode.WebviewPanel, sourceId: string, sessionKey: string): void {
    const source = this.sources.get(sourceId);
    if (source === undefined) {
      this.renderMessage(panel, `Unknown telemetry source "${sourceId}".`);
      return;
    }
    const result = source.getSessionDetail(sessionKey);
    if (!result.ok) {
      this.renderMessage(panel, result.message);
      return;
    }
    const detail = result.value;
    // Rename the editor tab from the placeholder id to the session's name (the
    // same LOCAL-ONLY title the Sessions list shows) once the detail is known.
    if (detail.summary.title !== undefined && detail.summary.title.length > 0) {
      panel.title = tabLabel(detail.summary.title);
    }
    const turnDeviations = this.detectTurnDeviations(source, sessionKey, detail);
    const costMode: CostMode = source.costMode;

    // Context analysis is produced by the owning source from its own raw data
    // (Copilot from span attributes, Claude from transcript + filesystem). A source
    // that can't produce it omits the method, and the tab stays hidden.
    const contextAnalysis = source.getContextAnalysis?.(sessionKey, this.readAcceptedMissing());

    if (this.mounted.has(panel)) {
      void panel.webview.postMessage({
        type: 'update',
        html: renderSessionDetailContent(detail, turnDeviations, contextAnalysis, costMode),
      });
      return;
    }
    panel.webview.html = renderSessionDetailHtml(detail, turnDeviations, makeNonce(), contextAnalysis, costMode);
    this.mounted.add(panel);
  }

  /** Render (or live-update) the COMBINED view for several same-source session keys. */
  private renderCombined(panel: vscode.WebviewPanel, sourceId: string, keys: readonly string[]): void {
    const source = this.sources.get(sourceId);
    if (source === undefined) {
      this.renderMessage(panel, `Unknown telemetry source "${sourceId}".`);
      return;
    }
    const sections: CombinedSessionSection[] = [];
    for (const key of keys) {
      const result = source.getSessionDetail(key);
      if (!result.ok) {
        continue;
      }
      sections.push({
        detail: result.value,
        turnDeviations: this.detectTurnDeviations(source, key, result.value),
      });
    }
    if (sections.length === 0) {
      this.renderMessage(panel, 'None of the selected sessions could be loaded.');
      return;
    }
    sections.sort((a, b) => a.detail.summary.startedAtMs - b.detail.summary.startedAtMs);
    const combined = combineSessionDetails(sections.map((s) => s.detail));
    const costMode: CostMode = source.costMode;

    if (this.mounted.has(panel)) {
      void panel.webview.postMessage({
        type: 'update',
        html: renderCombinedSessionDetailContent({ combined, sections }, costMode),
      });
      return;
    }
    panel.webview.html = renderCombinedSessionDetailHtml({ combined, sections }, makeNonce(), costMode);
    this.mounted.add(panel);
  }

  /**
   * Render (or live-update) the REPOSITORY view: every listed session of each
   * repository loaded and merged into one aggregate. Failed session loads are
   * counted and surfaced in the header (never dropped silently), as is the
   * source's truncation note. No per-turn deviations are computed — the view
   * renders no timeline — so this stays cheap even for large repositories.
   */
  private renderRepository(panel: vscode.WebviewPanel, sourceId: string, repositories: readonly string[]): void {
    const source = this.sources.get(sourceId);
    if (source === undefined) {
      this.renderMessage(panel, `Unknown telemetry source "${sourceId}".`);
      return;
    }
    const details: SessionDetail[] = [];
    const sections: RepositoryDetailSection[] = [];
    let failed = 0;
    let firstError: string | undefined;
    const seen = new Set<string>();
    for (const repository of repositories) {
      const listed = source.listSessions(repository);
      if (!listed.ok) {
        firstError ??= listed.message;
        sections.push({ repository, sessionCount: 0 });
        continue;
      }
      let count = 0;
      for (const summary of listed.value) {
        if (seen.has(summary.sessionId)) {
          continue; // defensive — a session belongs to exactly one repository
        }
        seen.add(summary.sessionId);
        const detail = source.getSessionDetail(summary.sessionId);
        if (detail.ok) {
          details.push(detail.value);
          count += 1;
        } else {
          failed += 1;
        }
      }
      sections.push({ repository, sessionCount: count });
    }
    if (details.length === 0) {
      this.renderMessage(panel, firstError ?? 'No sessions could be loaded for the selected repository(ies).');
      return;
    }
    const view: RepositoryDetailView = {
      combined: combineSessionDetails(details),
      repositories: sections,
      failedSessions: failed,
      truncationNote: source.truncationNote?.(),
    };
    const costMode: CostMode = source.costMode;

    if (this.mounted.has(panel)) {
      void panel.webview.postMessage({
        type: 'update',
        html: renderRepositoryDetailContent(view, costMode),
      });
      return;
    }
    panel.webview.html = renderRepositoryDetailHtml(view, makeNonce(), costMode);
    this.mounted.add(panel);
  }

  /**
   * Replace the panel with a standalone message document (unknown source / failed
   * load). A message doc has no live shell, so the panel is marked un-mounted —
   * the next successful render rebuilds the shell (and its `update` listener).
   */
  private renderMessage(panel: vscode.WebviewPanel, message: string): void {
    panel.webview.html = renderMessageHtml(message);
    this.mounted.delete(panel);
  }

  /**
   * Detect PER-TURN workflow deviations for a session, aligned by index to
   * `detail.turns`. Interactions are bucketed into the same user-request turns the
   * detail view renders, then each turn is checked independently. Workflow content
   * predicates read raw content through the source's own LOCAL-ONLY, memoized
   * {@link SessionDataSource.getSessionContent} (Copilot from span attributes,
   * Claude reconstructed from the transcript); a source that supplies none leaves
   * content predicates inert (the sequence/missing/timeout checks still run over
   * metadata).
   */
  private detectTurnDeviations(
    source: SessionDataSource,
    sessionKey: string,
    detail: SessionDetail,
  ): WorkflowDeviation[][] {
    const empty = detail.turns.map(() => [] as WorkflowDeviation[]);
    const interactions = source.getSessionInteractions(sessionKey);
    if (!interactions.ok) {
      return empty;
    }
    const attributeCache = new Map<string, ReadonlyMap<string, string>>();
    const contentLookup = (attribute: string): ReadonlyMap<string, string> => {
      let values = attributeCache.get(attribute);
      if (values === undefined) {
        // Each source supplies its own local-only content (Copilot from span
        // attributes, Claude reconstructed from the transcript); a source that
        // implements no lookup leaves content predicates inert.
        const result = source.getSessionContent?.(sessionKey, attribute);
        values = result?.ok ? result.value : new Map<string, string>();
        attributeCache.set(attribute, values);
      }
      return values;
    };
    const turns = groupInteractionsByTurn(
      interactions.value,
      detail.turns.map((t) => t.timestampMs),
    );
    return this.deviations.detectForTurns(turns, contentLookup);
  }
}

/** Minimal escaped message document for the failure path. */
function renderMessageHtml(message: string): string {
  const escaped = message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html><html><head><meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none';" />
    </head><body style="font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 1rem;">
    <p>${escaped}</p></body></html>`;
}

/** Short label for the editor tab. */
function shortLabel(sessionKey: string): string {
  const dash = sessionKey.indexOf('-');
  if (dash > 0) {
    return sessionKey.slice(0, dash);
  }
  return sessionKey.length > 12 ? `${sessionKey.slice(0, 12)}…` : sessionKey;
}

/** Editor-tab label for a titled session, kept short enough for a tab. */
function tabLabel(title: string): string {
  const collapsed = title.replace(/\s+/g, ' ').trim();
  return collapsed.length > 40 ? `${collapsed.slice(0, 40)}…` : collapsed;
}

/** Per-render CSP nonce, CSPRNG-backed (node:crypto), per VS Code convention. */
function makeNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}
