import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { TelemetryService } from '../telemetry/telemetryService';
import { LocalDeviationDetector } from '../deviation/localDeviations';
import { WorkflowDeviation } from '../deviation/models';
import { SessionDataSource, SourceRegistry } from '../sources/sessionSource';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';
import { analyzeContext, AcceptedMissingConfig } from '../context/contextAnalyzer';
import {
  CombinedSessionSection,
  CostMode,
  renderCombinedSessionDetailHtml,
  renderSessionDetailHtml,
} from './sessionDetailHtml';

/** Webview view type used for all session-detail panels. */
const VIEW_TYPE = 'agentObservability.sessionDetail';

/** A session addressed by its source + key. */
export interface SourceSession {
  sourceId: string;
  sessionKey: string;
}

/** Per-panel metadata, so live updates and re-renders can find their target. */
interface PanelMeta {
  /** Single-session panels: the source + key. Combined panels omit it. */
  single?: SourceSession;
}

/**
 * Manages the local session-detail webview panels across BOTH sources.
 *
 * A panel is keyed by `${sourceId}::${sessionKey}` (combined panels by their
 * sorted key set) so a Copilot and a Claude session that happen to share an id
 * never collide. The detail body is rendered from whichever
 * {@link SessionDataSource} owns the session; Copilot sessions additionally get
 * the local deviation + context-analysis passes (which read Copilot-only span
 * attributes via the concrete {@link TelemetryService}), while Claude sessions
 * run deviations over metadata only and skip context analysis. The cost basis
 * (AIU vs token-priced USD) follows the source.
 */
export class SessionDetailPanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();
  private readonly rerenderers = new Map<vscode.WebviewPanel, () => void>();
  private readonly meta = new Map<vscode.WebviewPanel, PanelMeta>();
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
      { enableScripts: true, retainContextWhenHidden: false },
    );
    panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panels.set(panelKey, panel);
    this.meta.set(panel, { single: { sourceId, sessionKey } });
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
      { enableScripts: true, retainContextWhenHidden: false },
    );
    panel.iconPath = new vscode.ThemeIcon('layers');
    this.panels.set(panelKey, panel);
    this.meta.set(panel, {});
    this.rerenderers.set(panel, () => this.renderCombined(panel, sourceId, keys));
    this.trackActive(panel);
    panel.onDidDispose(() => {
      this.panels.delete(panelKey);
      this.forget(panel);
    });

    this.renderCombined(panel, sourceId, keys);
  }

  /** Re-fetch fresh telemetry and redraw the focused detail panel. */
  refreshActive(): void {
    const panel = this.activePanel;
    if (panel === undefined) {
      return;
    }
    this.sources.refresh();
    this.rerenderers.get(panel)?.();
  }

  /**
   * Push a near-real-time live-status snapshot to any OPEN Copilot single-session
   * panel whose key matches a candidate id. Combined panels and Claude panels are
   * skipped (the OTel bridge is Copilot-only).
   */
  pushLiveUpdate(candidateIds: readonly string[], payload: unknown): void {
    if (candidateIds.length === 0) {
      return;
    }
    for (const [, panel] of this.panels) {
      const single = this.meta.get(panel)?.single;
      if (single !== undefined && single.sourceId === 'copilot' && candidateIds.includes(single.sessionKey)) {
        void panel.webview.postMessage({ type: 'liveUpdate', live: payload });
      }
    }
  }

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

  private forget(panel: vscode.WebviewPanel): void {
    this.rerenderers.delete(panel);
    this.meta.delete(panel);
    if (this.activePanel === panel) {
      this.activePanel = undefined;
    }
  }

  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
    this.rerenderers.clear();
    this.meta.clear();
    this.activePanel = undefined;
  }

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

  private readAcceptedMissing(): AcceptedMissingConfig {
    const config = vscode.workspace.getConfiguration('agentObservability.context');
    return {
      files: config.get<string[]>('acceptedMissingFiles', []),
      sources: config.get<string[]>('acceptedMissingSources', []),
    };
  }

  /** Load detail (+ Copilot deviations/context) and set the panel HTML. */
  private render(panel: vscode.WebviewPanel, sourceId: string, sessionKey: string): void {
    const source = this.sources.get(sourceId);
    if (source === undefined) {
      panel.webview.html = renderMessageHtml(`Unknown telemetry source "${sourceId}".`);
      return;
    }
    const result = source.getSessionDetail(sessionKey);
    if (!result.ok) {
      panel.webview.html = renderMessageHtml(result.message);
      return;
    }
    const detail = result.value;
    const found = this.detectDeviations(source, sessionKey);
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

    const nonce = makeNonce();
    panel.webview.html = renderSessionDetailHtml(detail, found, nonce, contextAnalysis, costMode);
  }

  /** Render the COMBINED view for several same-source session keys. */
  private renderCombined(panel: vscode.WebviewPanel, sourceId: string, keys: readonly string[]): void {
    const source = this.sources.get(sourceId);
    if (source === undefined) {
      panel.webview.html = renderMessageHtml(`Unknown telemetry source "${sourceId}".`);
      return;
    }
    const sections: CombinedSessionSection[] = [];
    for (const key of keys) {
      const result = source.getSessionDetail(key);
      if (!result.ok) {
        continue;
      }
      sections.push({ detail: result.value, deviations: this.detectDeviations(source, key) });
    }
    if (sections.length === 0) {
      panel.webview.html = renderMessageHtml('None of the selected sessions could be loaded.');
      return;
    }
    sections.sort((a, b) => a.detail.summary.startedAtMs - b.detail.summary.startedAtMs);
    const combined = combineSessionDetails(sections.map((s) => s.detail));
    const costMode: CostMode = source.id === 'claude' ? 'usd' : 'aiu';
    const nonce = makeNonce();
    panel.webview.html = renderCombinedSessionDetailHtml({ combined, sections }, nonce, costMode);
  }

  /**
   * Run the deviation detector over a session's safe-metadata interactions. For
   * Copilot, workflow content predicates read raw span attributes through a
   * LOCAL-ONLY memoized lookup; for other sources the lookup is empty (metadata
   * checks — sequence/timeout/failure — still run).
   */
  private detectDeviations(source: SessionDataSource, sessionKey: string): WorkflowDeviation[] {
    const interactions = source.getSessionInteractions(sessionKey);
    if (!interactions.ok) {
      return [];
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
    return this.deviations.detectForSession(interactions.value, contentLookup);
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
