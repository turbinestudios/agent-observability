import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import { TelemetryService } from '../telemetry/telemetryService';
import { LocalDeviationDetector } from '../deviation/localDeviations';
import { renderSessionDetailHtml } from './sessionDetailHtml';

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
        // Static HTML only — no scripts, no local resource roots needed.
        enableScripts: false,
        retainContextWhenHidden: false,
      },
    );
    panel.iconPath = new vscode.ThemeIcon('comment-discussion');
    this.panels.set(sessionKey, panel);
    panel.onDidDispose(() => {
      this.panels.delete(sessionKey);
    });

    this.render(panel, sessionKey);
  }

  /** Dispose every open panel (extension deactivate). */
  dispose(): void {
    for (const panel of this.panels.values()) {
      panel.dispose();
    }
    this.panels.clear();
  }

  /** Load detail + deviations and set the panel HTML. */
  private render(panel: vscode.WebviewPanel, sessionKey: string): void {
    const result = this.telemetry.getSessionDetail(sessionKey);
    if (!result.ok) {
      panel.webview.html = renderMessageHtml(result.message);
      return;
    }
    const detail = result.value;

    // Run the deviation detector over the SAFE-metadata interactions (which
    // carry the real agent_name the sequence/missing checks need). The
    // local-only userRequest content is never passed to the detector.
    let found: ReturnType<LocalDeviationDetector['detectForSession']> = [];
    const interactions = this.telemetry.getSessionInteractions(sessionKey);
    if (interactions.ok) {
      found = this.deviations.detectForSession(interactions.value);
    }

    const nonce = makeNonce();
    panel.webview.html = renderSessionDetailHtml(detail, found, nonce);
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
