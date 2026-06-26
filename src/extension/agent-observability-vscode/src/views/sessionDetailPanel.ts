import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { TelemetryService } from '../telemetry/telemetryService';
import { LocalDeviationDetector } from '../deviation/localDeviations';
import { WorkflowDeviation } from '../deviation/models';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';
import { analyzeContext, AcceptedMissingConfig } from '../context/contextAnalyzer';
import {
  CombinedSessionSection,
  renderCombinedSessionDetailHtml,
  renderSessionDetailHtml,
} from './sessionDetailHtml';

/** Webview view type used for all session-detail panels. */
const VIEW_TYPE = 'agentObservability.sessionDetail';

/**
 * Manages the local session-detail webview panels.
 *
 * One panel per session key (keyed registry): opening an already-open session
 * reveals the existing panel instead of creating a duplicate. Panels render
 * HTML under a strict per-render CSP with a fresh nonce (scripts are nonce-gated
 * for the interactive legend filter). The session timeline — including the
 * local-only `userRequest` — is rendered HTML-escaped and never leaves the
 * machine.
 */
export class SessionDetailPanelManager {
  private readonly panels = new Map<string, vscode.WebviewPanel>();

  /**
   * Per-panel re-render closure, used by {@link refreshActive} to redraw a panel
   * without re-threading its session key(s). Kept in sync with {@link panels} on
   * create/dispose.
   */
  private readonly rerenderers = new Map<vscode.WebviewPanel, () => void>();

  /** The currently focused detail panel, tracked via `onDidChangeViewState`. */
  private activePanel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly telemetry: TelemetryService,
    private readonly deviations: LocalDeviationDetector,
  ) {}

  /**
   * Open (or reveal) the detail panel for a session key. Loads the detail from
   * the telemetry service and renders it; on failure renders a single
   * explanatory message (never throwing into the command handler).
   */
  open(sessionKey: string): void {
    const existing = this.panels.get(sessionKey);
    if (existing !== undefined) {
      existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active);
      this.render(existing, sessionKey);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Session ${shortLabel(sessionKey)}`,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: false,
      },
    );
    panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panels.set(sessionKey, panel);
    this.rerenderers.set(panel, () => this.render(panel, sessionKey));
    this.trackActive(panel);
    panel.onDidDispose(() => {
      this.panels.delete(sessionKey);
      this.forget(panel);
    });
    this.registerMessageHandler(panel, sessionKey);

    this.render(panel, sessionKey);
  }

  /**
   * Open (or reveal) a SINGLE combined panel for a set of session keys. The keys
   * are de-duplicated and sorted to form a stable panel id, so reopening the same
   * selection reveals the existing panel. A selection of one falls back to the
   * regular single-session view.
   */
  openCombined(sessionKeys: readonly string[]): void {
    const keys = [...new Set(sessionKeys.filter((k) => k.length > 0))].sort();
    if (keys.length === 0) {
      return;
    }
    if (keys.length === 1) {
      this.open(keys[0]);
      return;
    }

    const panelId = `combined:${keys.join('|')}`;
    const existing = this.panels.get(panelId);
    if (existing !== undefined) {
      existing.reveal(existing.viewColumn ?? vscode.ViewColumn.Active);
      this.renderCombined(existing, keys);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      `Combined sessions (${keys.length})`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: false },
    );
    panel.iconPath = new vscode.ThemeIcon('layers');
    this.panels.set(panelId, panel);
    this.rerenderers.set(panel, () => this.renderCombined(panel, keys));
    this.trackActive(panel);
    panel.onDidDispose(() => {
      this.panels.delete(panelId);
      this.forget(panel);
    });

    this.renderCombined(panel, keys);
  }

  /**
   * Re-fetch fresh local telemetry and redraw the currently focused detail panel
   * — the title-bar Refresh button. Drops the cached snapshot first so the redraw
   * reflects new on-disk telemetry (the same data the navigation click would
   * load after a refresh), then replays the panel's render closure. Works for
   * both the single and combined views; a no-op when no detail panel is focused.
   */
  refreshActive(): void {
    const panel = this.activePanel;
    if (panel === undefined) {
      return;
    }
    this.telemetry.refresh();
    this.rerenderers.get(panel)?.();
  }

  /**
   * Push a near-real-time OTel live-status snapshot to any OPEN single-session
   * panel whose key matches one of the span's candidate ids. The detail body
   * stays SQLite-rendered; this only patches the live banner via `postMessage`
   * to the panel's client script. A no-op when no matching panel is open (and
   * combined panels, keyed `combined:…`, never match a raw session id).
   */
  pushLiveUpdate(candidateIds: readonly string[], payload: unknown): void {
    if (candidateIds.length === 0) {
      return;
    }
    for (const [key, panel] of this.panels) {
      if (candidateIds.includes(key)) {
        void panel.webview.postMessage({ type: 'liveUpdate', live: payload });
      }
    }
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
   * Register a message handler for webview → extension messages (accept-missing actions).
   * When a message arrives, the handler updates the workspace configuration and re-renders.
   */
  private registerMessageHandler(panel: vscode.WebviewPanel, sessionKey: string): void {
    panel.webview.onDidReceiveMessage(async (msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const message = msg as { type?: string; file?: string; source?: string };

      const config = vscode.workspace.getConfiguration('agentObservability.context');

      if (message.type === 'accept-missing-file' && typeof message.file === 'string') {
        const current: string[] = config.get('acceptedMissingFiles', []);
        if (!current.includes(message.file)) {
          await config.update('acceptedMissingFiles', [...current, message.file], vscode.ConfigurationTarget.Workspace);
        }
        this.render(panel, sessionKey);
      } else if (message.type === 'accept-missing-source' && typeof message.source === 'string') {
        const current: string[] = config.get('acceptedMissingSources', []);
        if (!current.includes(message.source)) {
          await config.update('acceptedMissingSources', [...current, message.source], vscode.ConfigurationTarget.Workspace);
        }
        this.render(panel, sessionKey);
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

  /** Load detail + deviations + context analysis and set the panel HTML. */
  private render(panel: vscode.WebviewPanel, sessionKey: string): void {
    const result = this.telemetry.getSessionDetail(sessionKey);
    if (!result.ok) {
      panel.webview.html = renderMessageHtml(result.message);
      return;
    }
    const detail = result.value;
    const found = this.detectDeviations(sessionKey);
    const acceptedMissing = this.readAcceptedMissing();

    // Extract distinct subagent friendly names from the already-resolved
    // agentUsage (same data the Overview tab uses). These are passed to the
    // context analyzer as a fallback name list so collapsibles show the same
    // friendly names even when discovery event IDs can't be matched by DB query.
    const subagentNamesList = [...new Set(
      detail.agentUsage
        .filter((u) => u.kind === 'subagent')
        .map((u) => u.agentName),
    )];
    const contextAnalysis = analyzeContext(sessionKey, this.telemetry, acceptedMissing, undefined, subagentNamesList);

    const nonce = makeNonce();
    panel.webview.html = renderSessionDetailHtml(detail, found, nonce, contextAnalysis);
  }

  /**
   * Render the COMBINED view for several session keys: fetch each session's
   * detail + deviations, sort the sections by start time, and merge the usage
   * rollups. Cost is derived from each session's AIU at render time. Sessions that
   * fail to load are skipped; when none load, a single explanatory message is shown.
   */
  private renderCombined(panel: vscode.WebviewPanel, keys: readonly string[]): void {
    const sections: CombinedSessionSection[] = [];
    for (const key of keys) {
      const result = this.telemetry.getSessionDetail(key);
      if (!result.ok) {
        continue;
      }
      sections.push({
        detail: result.value,
        deviations: this.detectDeviations(key),
      });
    }

    if (sections.length === 0) {
      panel.webview.html = renderMessageHtml('None of the selected sessions could be loaded.');
      return;
    }

    // Chronological by session start so the timeline reads top-to-bottom.
    sections.sort((a, b) => a.detail.summary.startedAtMs - b.detail.summary.startedAtMs);

    const combined = combineSessionDetails(sections.map((s) => s.detail));

    const nonce = makeNonce();
    panel.webview.html = renderCombinedSessionDetailHtml({ combined, sections }, nonce);
  }

  /**
   * Run the deviation detector over a session's SAFE-metadata interactions (which
   * carry the real agent_name the sequence/missing checks need). Workflow content
   * predicates (if any) read raw span attributes through a LOCAL-ONLY lookup,
   * memoized per attribute; that text is used only to compute booleans on-machine
   * and never enters a WorkflowDeviation or any networked path.
   */
  private detectDeviations(sessionKey: string): WorkflowDeviation[] {
    const interactions = this.telemetry.getSessionInteractions(sessionKey);
    if (!interactions.ok) {
      return [];
    }
    const attributeCache = new Map<string, ReadonlyMap<string, string>>();
    const contentLookup = (attribute: string): ReadonlyMap<string, string> => {
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
