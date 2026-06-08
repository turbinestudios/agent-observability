import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { TelemetryService } from '../telemetry/telemetryService';
import { LocalDeviationDetector } from '../deviation/localDeviations';
import { WorkflowDeviation } from '../deviation/models';
import { Configuration } from '../config/configuration';
import { computeCost, sumCost, CostEstimate } from '../telemetry/pricing';
import {
  SessionAgentUsage,
  SessionModelUsage,
  agentUsageKey,
} from '../telemetry/models';
import { combineSessionDetails } from '../telemetry/combinedSessionDetail';
import {
  CombinedSessionSection,
  SessionCostView,
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
 * STATIC HTML (no scripts) under a strict per-render CSP with a fresh nonce, and
 * are created WITHOUT `enableScripts`. The session timeline — including the
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
    private readonly config: Configuration,
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
        // Static HTML only — no scripts, no local resource roots needed.
        enableScripts: false,
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
      { enableScripts: false, retainContextWhenHidden: false },
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
   * Re-render EVERY open detail panel against the current telemetry, without
   * itself re-snapshotting — the caller (e.g. the live source watcher) is
   * expected to have already called {@link TelemetryService.refresh} once, so a
   * single fresh snapshot is shared across all panels. A no-op when nothing is
   * open. Used for near-live updates as Copilot writes new spans.
   */
  refreshAll(): void {
    for (const rerender of this.rerenderers.values()) {
      rerender();
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

  /** Load detail + deviations and set the panel HTML. */
  private render(panel: vscode.WebviewPanel, sessionKey: string): void {
    const result = this.telemetry.getSessionDetail(sessionKey);
    if (!result.ok) {
      panel.webview.html = renderMessageHtml(result.message);
      return;
    }
    const detail = result.value;
    const found = this.detectDeviations(sessionKey);

    // Estimated cost (LOCAL-ONLY): read pricing overrides fresh each render — this
    // path is already uncached, so editing rates and reopening reflects them.
    const cost = this.buildCostView(detail.modelUsage, detail.agentUsage);

    const nonce = makeNonce();
    panel.webview.html = renderSessionDetailHtml(detail, found, nonce, cost);
  }

  /**
   * Render the COMBINED view for several session keys: fetch each session's
   * detail + deviations, sort the sections by start time, merge the usage
   * rollups, and compute both per-session and merged cost. Sessions that fail to
   * load are skipped; when none load, a single explanatory message is shown.
   */
  private renderCombined(panel: vscode.WebviewPanel, keys: readonly string[]): void {
    const sections: CombinedSessionSection[] = [];
    for (const key of keys) {
      const result = this.telemetry.getSessionDetail(key);
      if (!result.ok) {
        continue;
      }
      const detail = result.value;
      const cost = this.buildCostView(detail.modelUsage, detail.agentUsage);
      sections.push({
        detail,
        deviations: this.detectDeviations(key),
        totalCost: cost.total,
      });
    }

    if (sections.length === 0) {
      panel.webview.html = renderMessageHtml('None of the selected sessions could be loaded.');
      return;
    }

    // Chronological by session start so the timeline reads top-to-bottom.
    sections.sort((a, b) => a.detail.summary.startedAtMs - b.detail.summary.startedAtMs);

    const combined = combineSessionDetails(sections.map((s) => s.detail));
    const cost = this.buildCostView(combined.modelUsage, combined.agentUsage);

    const nonce = makeNonce();
    panel.webview.html = renderCombinedSessionDetailHtml({ combined, cost, sections }, nonce);
  }

  /**
   * Build the LOCAL-ONLY cost view for a set of usage rollups. Reads the pricing
   * overrides fresh (the detail path is uncached) and computes a per-model and
   * per-agent estimate plus the per-model total. Copilot does not bill per token;
   * this is a configurable estimate, `n/a` until rates are set. The session total
   * is the main-thread per-model rollup — sub-agent costs are informational only.
   */
  private buildCostView(
    modelUsage: readonly SessionModelUsage[],
    agentUsage: readonly SessionAgentUsage[],
  ): SessionCostView {
    const overrides = this.config.getPricingOverrides();
    const costByModel = new Map<string, CostEstimate>(
      modelUsage.map((u) => [u.model, computeCost(u.model, u, overrides)]),
    );
    const costByAgent = new Map<string, CostEstimate>(
      agentUsage.map((u) => [agentUsageKey(u), computeCost(u.model, u, overrides)]),
    );
    // AIU is the authoritative billed usage (read straight from the rollups); the
    // optional usdPerAiu rate only adds a currency view of it.
    const usdPerAiu = this.config.getUsdPerAiu();
    return {
      costByModel,
      costByAgent,
      total: sumCost([...costByModel.values()]),
      usdPerAiu: usdPerAiu > 0 ? usdPerAiu : undefined,
    };
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
