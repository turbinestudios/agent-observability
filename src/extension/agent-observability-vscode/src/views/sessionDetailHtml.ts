import { SessionDetail, SessionTimelineEntry } from '../telemetry/models';
import { WorkflowDeviation } from '../deviation/models';
import { escapeHtml } from './escapeHtml';

/**
 * Render a numeric field. Today these are typed `number` and stringify to safe
 * digits, but routing them through escapeHtml(String(...)) is defense-in-depth:
 * the webview's XSS-safety no longer depends on the upstream type never becoming
 * a string in some future refactor.
 */
function num(value: number): string {
  return escapeHtml(String(value));
}

/**
 * Pure HTML renderer for the local session-detail webview.
 *
 * No `vscode` import: the panel ({@link ./sessionDetailPanel}) wraps this and
 * supplies the per-render nonce. Keeping rendering pure means the XSS-safety
 * behaviour is unit-tested headless against crafted entries.
 *
 * SECURITY:
 * - Every dynamic value passes through {@link escapeHtml} (privacy-critical for
 *   `userRequest`, which may contain arbitrary markup).
 * - The document declares a strict Content-Security-Policy: `default-src 'none'`,
 *   styles allowed only via the supplied nonce, no scripts, no external/CDN
 *   resources. The webview itself is created WITHOUT `enableScripts` — the page
 *   is static HTML using native `<details>` for collapsing.
 */
export function renderSessionDetailHtml(
  detail: SessionDetail,
  deviations: readonly WorkflowDeviation[],
  nonce: string,
): string {
  const { summary } = detail;
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "font-src 'none'",
    "script-src 'none'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Session ${escapeHtml(shortId(summary.sessionId))}</title>
  <style nonce="${nonce}">${STYLE}</style>
</head>
<body>
  ${renderHeader(detail)}
  ${renderDeviations(deviations)}
  ${renderTimeline(detail.timeline)}
</body>
</html>`;
}

/** Sanitized header: repository, model, start/end, counts, token totals. */
function renderHeader(detail: SessionDetail): string {
  const s = detail.summary;
  const modes = s.agentModes.map(escapeHtml).join(', ');
  return `<header class="header">
    <p class="eyebrow">Session</p>
    <h1>${escapeHtml(shortId(s.sessionId))}</h1>
    <dl class="meta">
      <div><dt>Repository</dt><dd>${escapeHtml(s.repository)}</dd></div>
      <div><dt>Model</dt><dd>${escapeHtml(s.model)}</dd></div>
      <div><dt>Modes</dt><dd>${modes}</dd></div>
      <div><dt>Started</dt><dd>${escapeHtml(formatLocal(s.startedAtMs))}</dd></div>
      <div><dt>Ended</dt><dd>${escapeHtml(formatLocal(s.endedAtMs))}</dd></div>
      <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(s.durationMs))}</dd></div>
      <div><dt>Interactions</dt><dd>${num(s.interactionCount)}</dd></div>
      <div><dt>LLM calls</dt><dd>${num(s.llmCalls)}</dd></div>
      <div><dt>Tool calls</dt><dd>${num(s.toolCalls)}</dd></div>
      <div><dt>Tokens in / out</dt><dd>${num(s.inputTokens)} / ${num(s.outputTokens)} (cached ${num(s.cachedTokens)})</dd></div>
    </dl>
  </header>`;
}

/** Workflow-deviations section (parity with the cloud SessionDetail page). */
function renderDeviations(deviations: readonly WorkflowDeviation[]): string {
  if (deviations.length === 0) {
    return `<section class="panel">
      <div class="panel-heading"><h2>Workflow Deviations</h2><span>No deviations detected</span></div>
      <p class="muted">This session's workflow matches expected patterns.</p>
    </section>`;
  }

  const cards = deviations
    .map((d) => {
      const actual =
        d.actualSequence !== undefined && d.actualSequence.length > 0
          ? `<div class="seq"><strong>Actual:</strong> ${d.actualSequence.map(escapeHtml).join(' → ')}</div>`
          : '';
      const expected =
        d.expectedSequence !== undefined && d.expectedSequence.length > 0
          ? `<div class="seq"><strong>Expected:</strong> ${d.expectedSequence.map(escapeHtml).join(' → ')}</div>`
          : '';
      return `<article class="deviation deviation-${escapeHtml(d.type.toLowerCase())}">
        <div class="deviation-head">
          <span class="badge">${escapeHtml(d.type)}</span>
          <span class="muted">${escapeHtml(d.workflowName)}</span>
        </div>
        <p>${escapeHtml(d.description)}</p>
        ${actual}
        ${expected}
      </article>`;
    })
    .join('\n');

  return `<section class="panel">
    <div class="panel-heading"><h2>Workflow Deviations</h2><span>${num(deviations.length)} issue(s) detected</span></div>
    <div class="deviation-list">${cards}</div>
  </section>`;
}

/** Chronological timeline; chat entries expose their escaped userRequest. */
function renderTimeline(timeline: readonly SessionTimelineEntry[]): string {
  const rows = timeline.map(renderTimelineRow).join('\n');
  return `<section class="panel">
    <div class="panel-heading"><h2>Timeline</h2><span>${num(timeline.length)} interaction(s)</span></div>
    <div class="timeline">${rows}</div>
  </section>`;
}

/** One timeline row. The userRequest (if any) is escaped and collapsible. */
export function renderTimelineRow(entry: SessionTimelineEntry): string {
  const target =
    entry.toolName !== undefined && entry.toolName.length > 0
      ? escapeHtml(entry.toolName)
      : escapeHtml(entry.model);
  const status = entry.success
    ? '<span class="status ok" title="Success">✓</span>'
    : '<span class="status fail" title="Failed">✗</span>';

  const request =
    entry.operation === 'chat' && entry.userRequest !== undefined && entry.userRequest.length > 0
      ? `<details class="request"><summary>User request</summary><pre>${escapeHtml(
          entry.userRequest,
        )}</pre></details>`
      : '';

  return `<div class="row">
    <div class="row-main">
      <span class="time">${escapeHtml(formatTime(entry.timestampMs))}</span>
      <span class="op op-${escapeHtml(entry.operation)}">${escapeHtml(entry.operation)}</span>
      <span class="mode">${escapeHtml(entry.agentMode)}</span>
      <span class="target">${target}</span>
      <span class="dur">${escapeHtml(formatDuration(entry.durationMs))}</span>
      ${status}
    </div>
    ${request}
  </div>`;
}

/** First UUID segment, else a truncated id. */
function shortId(sessionId: string): string {
  const dash = sessionId.indexOf('-');
  if (dash > 0) {
    return sessionId.slice(0, dash);
  }
  return sessionId.length > 12 ? `${sessionId.slice(0, 12)}…` : sessionId;
}

/** Local date+time string for the header. */
function formatLocal(epochMs: number): string {
  return new Date(epochMs).toLocaleString();
}

/** Local time-of-day for timeline rows. */
function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString();
}

/** Human duration: sub-second in ms, otherwise seconds. */
function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  return `${(ms / 1000).toFixed(1)} s`;
}

/** Theme-aware styles (VS Code CSS variables). Injected under the CSP nonce. */
const STYLE = `
  :root { color-scheme: light dark; }
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    margin: 0; padding: 1rem 1.25rem;
  }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 0; }
  .eyebrow { text-transform: uppercase; letter-spacing: .06em; font-size: .72rem; color: var(--vscode-descriptionForeground); margin: 0; }
  .muted { color: var(--vscode-descriptionForeground); }
  .header { margin-bottom: 1.25rem; }
  .meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .35rem .9rem; margin: .75rem 0 0; }
  .meta dt { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .meta dd { margin: 0; word-break: break-word; }
  .panel { border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); border-radius: 6px; padding: .75rem .9rem; margin-bottom: 1rem; background: var(--vscode-editorWidget-background); }
  .panel-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: .5rem; }
  .panel-heading span { color: var(--vscode-descriptionForeground); font-size: .8rem; }
  .deviation-list { display: flex; flex-direction: column; gap: .6rem; }
  .deviation { border-left: 3px solid var(--vscode-editorWarning-foreground, #c90); padding: .4rem .6rem; background: var(--vscode-inputValidation-warningBackground, transparent); border-radius: 0 4px 4px 0; }
  .deviation p { margin: .3rem 0; }
  .deviation-head { display: flex; align-items: center; gap: .5rem; }
  .badge { display: inline-block; font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: .1rem .4rem; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .seq { font-size: .82rem; color: var(--vscode-descriptionForeground); }
  .timeline { display: flex; flex-direction: column; }
  .row { padding: .35rem 0; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  .row:last-child { border-bottom: none; }
  .row-main { display: flex; align-items: center; gap: .65rem; flex-wrap: wrap; }
  .time { font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); min-width: 5.5em; }
  .op { font-size: .72rem; font-weight: 600; text-transform: uppercase; letter-spacing: .03em; padding: .08rem .4rem; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .mode { color: var(--vscode-descriptionForeground); }
  .target { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  .dur { margin-left: auto; font-variant-numeric: tabular-nums; color: var(--vscode-descriptionForeground); }
  .status.ok { color: var(--vscode-testing-iconPassed, #3a3); }
  .status.fail { color: var(--vscode-testing-iconFailed, #d33); }
  .request { margin: .35rem 0 0 5.5em; }
  .request summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: .82rem; }
  .request pre { white-space: pre-wrap; word-break: break-word; margin: .35rem 0 0; padding: .5rem .6rem; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border-radius: 4px; max-height: 22rem; overflow: auto; }
`;
