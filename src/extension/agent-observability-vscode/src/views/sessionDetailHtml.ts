import {
  SessionDetail,
  SessionModelUsage,
  SessionAgentUsage,
  SessionTimelineEntry,
  SessionTurn,
  agentUsageKey,
} from '../telemetry/models';
import { WorkflowDeviation } from '../deviation/models';
import { CostEstimate, sumCost } from '../telemetry/pricing';
import { escapeHtml } from './escapeHtml';

/**
 * Per-render cost data computed by the panel (where settings are available) and
 * passed in as plain data so this module stays `vscode`-free. `costByModel` is
 * keyed by the RAW resolved model id used in {@link SessionModelUsage.model};
 * `costByAgent` is keyed by {@link ../telemetry/models.agentUsageKey} for the
 * per-agent breakdown; `total` is the {@link ../telemetry/pricing.sumCost} rollup
 * over the main-thread per-model estimates (sub-agents are not in the total).
 */
export interface SessionCostView {
  costByModel: ReadonlyMap<string, CostEstimate>;
  costByAgent?: ReadonlyMap<string, CostEstimate>;
  total: { available: boolean; totalUsd: number; partial: boolean };
}

/**
 * The minimal shape {@link formatCost} reads. Both a {@link CostEstimate} and the
 * {@link SessionCostView.total} rollup satisfy it structurally.
 */
type Costish = { available: boolean; totalUsd?: number; partial?: boolean } | undefined;

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
  cost?: SessionCostView,
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
  ${renderHeader(detail, cost)}
  ${renderModelUsage(detail.modelUsage, cost?.costByModel)}
  ${renderSubAgentUsage(detail.agentUsage, cost?.costByAgent)}
  ${renderDeviations(deviations)}
  ${renderTurns(detail.turns)}
</body>
</html>`;
}

/** Sanitized header: repository, model, start/end, counts, token totals, cost. */
function renderHeader(detail: SessionDetail, cost?: SessionCostView): string {
  const s = detail.summary;
  const modes = s.agentModes.map(escapeHtml).join(', ');
  // Distinct main-thread agent name(s) — usually just "GitHub Copilot Chat".
  // Shown only when present so non-agent sessions keep the original layout.
  const mainAgents = [
    ...new Set(detail.agentUsage.filter((u) => u.kind === 'main').map((u) => u.agentName)),
  ];
  const agentRow =
    mainAgents.length > 0
      ? `\n      <div><dt>Agent</dt><dd>${mainAgents.map(escapeHtml).join(', ')}</dd></div>`
      : '';
  // Estimated cost is shown only for sessions that made LLM calls (the same
  // condition that produces a model-usage rollup); otherwise it is meaningless.
  const costRow =
    detail.modelUsage.length > 0
      ? `\n      <div><dt>Estimated cost</dt><dd>${formatCost(cost?.total)}</dd></div>`
      : '';
  return `<header class="header">
    <p class="eyebrow">Session</p>
    <h1>${escapeHtml(shortId(s.sessionId))}</h1>
    <dl class="meta">
      <div><dt>Repository</dt><dd>${escapeHtml(s.repository)}</dd></div>
      <div><dt>Model</dt><dd>${escapeHtml(s.model)}</dd></div>${agentRow}
      <div><dt>Modes</dt><dd>${modes}</dd></div>
      <div><dt>Started</dt><dd>${escapeHtml(formatLocal(s.startedAtMs))}</dd></div>
      <div><dt>Ended</dt><dd>${escapeHtml(formatLocal(s.endedAtMs))}</dd></div>
      <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(s.durationMs))}</dd></div>
      <div><dt>Interactions</dt><dd>${num(s.interactionCount)}</dd></div>
      <div><dt>LLM calls</dt><dd>${num(s.llmCalls)}</dd></div>
      <div><dt>Tool calls</dt><dd>${num(s.toolCalls)}</dd></div>
      <div><dt>Tokens in / out</dt><dd>${num(s.inputTokens)} / ${num(s.outputTokens)} (cached ${num(s.cachedTokens)})</dd></div>${costRow}
    </dl>
  </header>`;
}

/**
 * Per-model "Cost & tokens by model" table. Rendered only when there is at least
 * one model-usage row. Each row's cost comes from `costByModel`; the totals row
 * sums the usage rows and shows the session cost rollup. Costs are ESTIMATES —
 * `n/a` until the user configures `agentObservability.pricing.modelRates`.
 */
function renderModelUsage(
  usage: readonly SessionModelUsage[],
  costByModel?: ReadonlyMap<string, CostEstimate>,
): string {
  if (usage.length === 0) {
    return '';
  }

  const totals = usage.reduce(
    (acc, u) => {
      acc.llmCalls += u.llmCalls;
      acc.inputTokens += u.inputTokens;
      acc.outputTokens += u.outputTokens;
      acc.cachedTokens += u.cachedTokens;
      acc.reasoningTokens += u.reasoningTokens;
      return acc;
    },
    { llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
  );

  const totalCost = sumCostView(usage, costByModel);

  const bodyRows = usage
    .map(
      (u) => `<tr>
        <td class="model">${escapeHtml(u.model)}</td>
        <td class="n">${num(u.llmCalls)}</td>
        <td class="n">${num(u.inputTokens)}</td>
        <td class="n">${num(u.outputTokens)}</td>
        <td class="n">${num(u.cachedTokens)}</td>
        <td class="n">${num(u.reasoningTokens)}</td>
        <td class="n">${formatCost(costByModel?.get(u.model))}</td>
      </tr>`,
    )
    .join('\n');

  return `<section class="panel">
    <div class="panel-heading"><h2>Cost &amp; tokens by model</h2><span>${num(usage.length)} model(s)</span></div>
    <table>
      <thead>
        <tr>
          <th>Model</th><th class="n" title="LLM calls to this model (chat and agent invocations)">Calls</th><th class="n">Input</th>
          <th class="n">Output</th><th class="n">Cached</th><th class="n">Reasoning</th>
          <th class="n">Est. cost</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
      <tfoot>
        <tr>
          <td class="model">Total</td>
          <td class="n">${num(totals.llmCalls)}</td>
          <td class="n">${num(totals.inputTokens)}</td>
          <td class="n">${num(totals.outputTokens)}</td>
          <td class="n">${num(totals.cachedTokens)}</td>
          <td class="n">${num(totals.reasoningTokens)}</td>
          <td class="n">${formatCost(totalCost)}</td>
        </tr>
      </tfoot>
    </table>
  </section>`;
}

/**
 * "Spawned sub-agents" breakdown: one row per (agent, model) the main agent
 * launched via a `runSubagent` tool call. Rendered only when the session spawned
 * at least one sub-agent. These tokens are deliberately EXCLUDED from the session
 * totals and the "by model" table above (they are counted in each sub-agent's own
 * session); the heading note makes that explicit so the smaller header total is
 * not mistaken for lost data.
 */
function renderSubAgentUsage(
  usage: readonly SessionAgentUsage[],
  costByAgent?: ReadonlyMap<string, CostEstimate>,
): string {
  const subs = usage.filter((u) => u.kind === 'subagent');
  if (subs.length === 0) {
    return '';
  }

  const totals = subs.reduce(
    (acc, u) => {
      acc.llmCalls += u.llmCalls;
      acc.inputTokens += u.inputTokens;
      acc.outputTokens += u.outputTokens;
      acc.cachedTokens += u.cachedTokens;
      acc.reasoningTokens += u.reasoningTokens;
      return acc;
    },
    { llmCalls: 0, inputTokens: 0, outputTokens: 0, cachedTokens: 0, reasoningTokens: 0 },
  );
  const subtotalCost = sumCost(subs.map((u) => costByAgent?.get(agentUsageKey(u)) ?? { available: false }));

  const bodyRows = subs
    .map(
      (u) => `<tr>
        <td>${escapeHtml(u.agentName)}</td>
        <td class="model">${escapeHtml(u.model)}</td>
        <td class="n">${num(u.llmCalls)}</td>
        <td class="n">${num(u.inputTokens)}</td>
        <td class="n">${num(u.outputTokens)}</td>
        <td class="n">${num(u.cachedTokens)}</td>
        <td class="n">${num(u.reasoningTokens)}</td>
        <td class="n">${formatCost(costByAgent?.get(agentUsageKey(u)))}</td>
      </tr>`,
    )
    .join('\n');

  return `<section class="panel">
    <div class="panel-heading"><h2>Spawned sub-agents</h2><span>${num(subs.length)} invocation group(s)</span></div>
    <p class="muted">Sub-agents launched by this session via <code>runSubagent</code>. Their tokens are counted in each sub-agent's own session, so they are shown here for visibility but are NOT included in the session totals above.</p>
    <table>
      <thead>
        <tr>
          <th>Agent</th><th>Model</th><th class="n">Calls</th><th class="n">Input</th>
          <th class="n">Output</th><th class="n">Cached</th><th class="n">Reasoning</th>
          <th class="n">Est. cost</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
      <tfoot>
        <tr>
          <td>Sub-agent total</td>
          <td class="model"></td>
          <td class="n">${num(totals.llmCalls)}</td>
          <td class="n">${num(totals.inputTokens)}</td>
          <td class="n">${num(totals.outputTokens)}</td>
          <td class="n">${num(totals.cachedTokens)}</td>
          <td class="n">${num(totals.reasoningTokens)}</td>
          <td class="n">${formatCost(subtotalCost)}</td>
        </tr>
      </tfoot>
    </table>
  </section>`;
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
      // Content-derived deviations are computed from raw local-only content and
      // can never be synced; flag them so the distinction is visible.
      const localOnly = d.contentDerived
        ? '<span class="badge badge-local" title="Derived from local-only content (e.g. a prompt or tool argument). Never eligible for sync.">Local only</span>'
        : '';
      return `<article class="deviation deviation-${escapeHtml(d.type.toLowerCase())}">
        <div class="deviation-head">
          <span class="badge">${escapeHtml(d.type)}</span>
          ${localOnly}
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

/**
 * Timeline grouped into per-user-request turns. Each turn is a top-level block
 * with two collapsed `<details>`: the User Request (which itself nests the
 * collapsible event timeline) and the Final LLM Response.
 */
function renderTurns(turns: readonly SessionTurn[]): string {
  const blocks = turns.map(renderTurn).join('\n');
  return `<section class="panel">
    <div class="panel-heading"><h2>Timeline</h2><span>${num(turns.length)} turn(s)</span></div>
    <div class="turns">${blocks}</div>
  </section>`;
}

/**
 * One user-request turn. Renders (all collapsed by default — no `open`):
 * - a **User Request** `<details>` whose body is the escaped request text plus a
 *   nested **Timeline** `<details>` of the triggered events; and
 * - a **Final LLM Response** `<details>` with the escaped response text.
 *
 * The synthetic request-less turn (spans before the first anchor) renders an
 * "Activity" disclosure holding just the nested timeline. Exported so the
 * webview's XSS-safety is unit-tested against crafted request/response content.
 */
export function renderTurn(turn: SessionTurn): string {
  const time = escapeHtml(formatTime(turn.timestampMs));
  const events = turn.events.map(renderTimelineRow).join('\n');
  const timeline = `<details class="timeline-disclosure"><summary>Timeline (${num(
    turn.events.length,
  )} event(s))</summary><div class="timeline">${events}</div></details>`;

  const hasRequest = turn.userRequest !== undefined && turn.userRequest.length > 0;
  const requestBody = hasRequest
    ? `<pre>${escapeHtml(turn.userRequest as string)}</pre>${timeline}`
    : timeline;
  const label = hasRequest
    ? '<span class="turn-label">User request</span>'
    : '<span class="turn-label muted">Activity (no user request)</span>';
  const requestSummary = `<span class="time">${time}</span>${label}${renderTurnTokens(turn)}`;
  const request = `<details class="turn-request"><summary>${requestSummary}</summary>${requestBody}</details>`;

  const response =
    turn.finalResponse !== undefined && turn.finalResponse.length > 0
      ? `<details class="turn-response"><summary><span class="turn-label">Final LLM response</span></summary><pre>${escapeHtml(
          turn.finalResponse,
        )}</pre></details>`
      : '';

  return `<div class="turn">
    ${request}
    ${response}
  </div>`;
}

/**
 * Compact token badge for a turn's summary row: input ↑ / output ↓, with the
 * cached/reasoning split and LLM-call count in the tooltip. Omitted when the turn
 * made no main-thread LLM call (e.g. a tool-only synthetic turn).
 */
function renderTurnTokens(turn: SessionTurn): string {
  if (turn.llmCalls === 0) {
    return '';
  }
  const title =
    `${turn.llmCalls} LLM call(s) · ${turn.inputTokens} in / ${turn.outputTokens} out ` +
    `(cached ${turn.cachedTokens}, reasoning ${turn.reasoningTokens})`;
  return `<span class="turn-tokens" title="${escapeHtml(title)}">↑ ${num(
    turn.inputTokens,
  )} ↓ ${num(turn.outputTokens)}</span>`;
}

/** One nested event row (tool / hook / sub-agent invocation) within a turn. */
export function renderTimelineRow(entry: SessionTimelineEntry): string {
  const target =
    entry.toolName !== undefined && entry.toolName.length > 0
      ? escapeHtml(entry.toolName)
      : escapeHtml(entry.model);
  const status = entry.success
    ? '<span class="status ok" title="Success">✓</span>'
    : '<span class="status fail" title="Failed">✗</span>';

  return `<div class="row">
    <div class="row-main">
      <span class="time">${escapeHtml(formatTime(entry.timestampMs))}</span>
      <span class="op op-${escapeHtml(entry.operation)}">${escapeHtml(entry.operation)}</span>
      <span class="mode">${escapeHtml(entry.agentMode)}</span>
      <span class="target">${target}</span>
      <span class="dur">${escapeHtml(formatDuration(entry.durationMs))}</span>
      ${status}
    </div>
  </div>`;
}

/**
 * Roll up the per-model estimates into a session total for the table footer,
 * mirroring the header total the panel passes in. When `costByModel` is absent
 * (e.g. the renderer is called without cost data), every model is unpriced and
 * the total is unavailable → `n/a`.
 */
function sumCostView(
  usage: readonly SessionModelUsage[],
  costByModel?: ReadonlyMap<string, CostEstimate>,
): { available: boolean; totalUsd: number; partial: boolean } {
  const estimates: CostEstimate[] = usage.map(
    (u) => costByModel?.get(u.model) ?? { available: false },
  );
  return sumCost(estimates);
}

/**
 * Format a cost as a clearly-labelled ESTIMATE:
 * - available → `$0.0000 (est.)` (the `(est.)` label is mandatory — Copilot does
 *   not bill per token, so this is never an authoritative figure);
 * - a partial session total → append ` + n/a` (some models priced, some not);
 * - unavailable (no rate configured) → `n/a`, never `$0`.
 */
function formatCost(cost: Costish): string {
  if (cost === undefined || !cost.available) {
    return 'n/a';
  }
  const base = `$${(cost.totalUsd ?? 0).toFixed(4)} (est.)`;
  return cost.partial === true ? `${base} + n/a` : base;
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
  .badge-local { background: var(--vscode-inputValidation-warningBackground, transparent); color: var(--vscode-editorWarning-foreground, #c90); border: 1px solid var(--vscode-editorWarning-foreground, #c90); }
  .seq { font-size: .82rem; color: var(--vscode-descriptionForeground); }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  thead th { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.model { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  tfoot td { font-weight: 600; border-bottom: none; border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  .turns { display: flex; flex-direction: column; gap: .5rem; }
  .turn { border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); border-radius: 5px; overflow: hidden; }
  .turn-request > summary, .turn-response > summary { cursor: pointer; display: flex; align-items: center; gap: .65rem; padding: .45rem .6rem; list-style: none; }
  .turn-request > summary::-webkit-details-marker, .turn-response > summary::-webkit-details-marker { display: none; }
  .turn-request > summary::before, .turn-response > summary::before { content: '▸'; color: var(--vscode-descriptionForeground); font-size: .8rem; }
  .turn-request[open] > summary::before, .turn-response[open] > summary::before { content: '▾'; }
  .turn-request > summary:hover, .turn-response > summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
  .turn-response { border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  .turn-label { font-weight: 600; }
  .turn-tokens { margin-left: auto; font-variant-numeric: tabular-nums; font-size: .78rem; color: var(--vscode-descriptionForeground); white-space: nowrap; }
  .turn-request > pre, .turn-response > pre { white-space: pre-wrap; word-break: break-word; margin: 0 .6rem .6rem; padding: .5rem .6rem; background: var(--vscode-textCodeBlock-background, var(--vscode-editor-background)); border-radius: 4px; max-height: 28rem; overflow: auto; }
  .timeline-disclosure { margin: 0 .6rem .6rem; }
  .timeline-disclosure > summary { cursor: pointer; color: var(--vscode-textLink-foreground); font-size: .82rem; padding: .2rem 0; }
  .timeline { display: flex; flex-direction: column; padding-left: .4rem; border-left: 2px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
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
`;
