import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { TelemetryService } from '../telemetry/telemetryService';
import { LocalDeviationDetector } from '../deviation/localDeviations';
import { WorkflowDeviation } from '../deviation/models';
import { groupInteractionsByTurn } from '../deviation/turnGrouping';
import { SessionDetail } from '../telemetry/models';
import { SessionDataSource, SourceRegistry } from '../sources/sessionSource';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';
import { analyzeContext, AcceptedMissingConfig } from '../context/contextAnalyzer';
import {
  CombinedSessionSection,
  CostMode,
  renderCombinedSessionDetailHtml,
  renderCombinedSessionDetailContent,
  renderSessionDetailHtml,
  renderSessionDetailContent,
} from './sessionDetailHtml';

/** Webview view type used for all session-detail panels. */
const VIEW_TYPE = 'agentObservability.sessionDetail';

/** A session addressed by its source + key. */
export interface SourceSession {
  sourceId: string;
  sessionKey: string;
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
    private readonly telemetry: TelemetryService,
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
   * Register a message handler for webview → extension messages (accept-missing
   * actions). When a message arrives, the handler updates the workspace
   * configuration and re-renders.
   */
  private registerMessageHandler(panel: vscode.WebviewPanel, sourceId: string, sessionKey: string): void {
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const message = msg as { type?: string; file?: string; source?: string };
      const config = vscode.workspace.getConfiguration('agentObservability.context');

      if (message.type === 'accept-missing-file' && typeof message.file === 'string') {
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
    const turnDeviations = this.detectTurnDeviations(source, sessionKey, detail);
    const costMode: CostMode = source.id === 'claude' ? 'usd' : 'aiu';

    // Context analysis reads Copilot-only span attributes; skip for other sources.
    let contextAnalysis = undefined;
    if (source.id === 'copilot') {
      const subagentNamesList = [
        ...new Set(detail.agentUsage.filter((u) => u.kind === 'subagent').map((u) => u.agentName)),
      ];
      contextAnalysis = analyzeContext(
        sessionKey,
        this.telemetry,
        this.readAcceptedMissing(),
        undefined,
        subagentNamesList,
      );
    }

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
    const costMode: CostMode = source.id === 'claude' ? 'usd' : 'aiu';

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
   * detail view renders, then each turn is checked independently. For Copilot,
   * workflow content predicates read raw span attributes through a LOCAL-ONLY
   * memoized lookup; for other sources the lookup is empty (the
   * sequence/missing/timeout checks still run over metadata).
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
      if (source.id !== 'copilot') {
        return new Map<string, string>();
      }
      let values = attributeCache.get(attribute);
      if (values === undefined) {
        const result = this.telemetry.getSpanAttributes(sessionKey, attribute);
        values = result.ok ? result.value : new Map<string, string>();
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

/** Per-render CSP nonce, CSPRNG-backed (node:crypto), per VS Code convention. */
function makeNonce(): string {
  return crypto.randomBytes(16).toString('base64url');
}
