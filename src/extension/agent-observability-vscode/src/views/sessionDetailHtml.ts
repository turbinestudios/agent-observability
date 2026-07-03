import {
  CombinedSessionDetail,
  CombinedSummary,
  SessionDetail,
  SessionTreeStats,
  SessionAgentUsage,
  SessionTimelineEntry,
  SessionTurn,
  SessionModelTurnPoint,
} from '../telemetry/models';
import { WorkflowDeviation } from '../deviation/models';
import { SessionContextAnalysis, AgentContextAnalysis, ContextFileEntry } from '../context/models';
import { aiuToUsd } from '../telemetry/pricing';
import { UNKNOWN_REPOSITORY } from '../telemetry/repositoryUrl';
import { escapeHtml } from './escapeHtml';

/**
 * How a session's cost is expressed. Copilot bills in AIU (`aiu`); Claude Code is
 * priced by tokens and carries `costUsdMicros` on its rollups (`usd`). The detail
 * panel passes the cost mode matching the session's source so the "Agent run
 * totals" card and usage tables show the right unit.
 */
export type CostMode = 'aiu' | 'usd';

/** Format integer micro-USD (1 USD = 1e6) as `$X.XX`. Safe to inject (digits/$.). */
function formatUsdMicros(micros: number | undefined): string {
  const usd = (micros ?? 0) / 1_000_000;
  if (!(usd > 0)) {
    return '$0.00';
  }
  return `$${usd.toFixed(usd < 0.01 ? 4 : 2)}`;
}

/** One combined session, paired with the data the panel resolves per session. */
export interface CombinedSessionSection {
  detail: SessionDetail;
  /**
   * Per-turn workflow deviations for THIS session, aligned by index to
   * `detail.turns` and rendered as chips inside the timeline (no overview section).
   */
  turnDeviations: readonly (readonly WorkflowDeviation[])[];
}

/**
 * Everything the combined renderer needs, assembled by the panel (where the
 * deviation detector is available). {@link combined} carries the merged header +
 * usage rollups; each {@link CombinedSessionSection} renders one session's own
 * meta, deviations, and turns. Sections are rendered in the order given (the panel
 * sorts by start time).
 */
export interface CombinedSessionView {
  combined: CombinedSessionDetail;
  sections: readonly CombinedSessionSection[];
}

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
 * Render an integer with thousands separators, matching GitHub's Agent Debug Logs
 * (e.g. `9042804` → `9,042,804`). Grouping is applied to the digit run only, so a
 * sign is preserved. Still routed through {@link escapeHtml} for defense-in-depth.
 */
function formatInt(value: number): string {
  return escapeHtml(String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
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
 *   styles and scripts allowed only via the supplied nonce, no external/CDN
 *   resources. Scripts are limited to the inline legend-filter interaction.
 */
export function renderSessionDetailHtml(
  detail: SessionDetail,
  turnDeviations: readonly (readonly WorkflowDeviation[])[],
  nonce: string,
  contextAnalysis?: SessionContextAnalysis,
  costMode: CostMode = 'aiu',
): string {
  const { summary } = detail;
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "font-src 'none'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(
    summary.title !== undefined && summary.title.length > 0
      ? truncate(summary.title, 60)
      : `Session ${shortId(summary.sessionId)}`,
  )}</title>
  <style nonce="${nonce}">${STYLE}</style>
</head>
<body>
  <div id="live-root">${renderSessionDetailContent(detail, turnDeviations, contextAnalysis, costMode)}</div>
  <script nonce="${nonce}">${WEBVIEW_CONTROLLER}</script>
</body>
</html>`;
}

/**
 * The mutable BODY of the single-session view — the tab bar + panels, WITHOUT the
 * document shell, styles, or scripts. {@link renderSessionDetailHtml} wraps this in
 * `#live-root` for the INITIAL render; on a live/refresh re-render the panel posts
 * the SAME markup as an `update` message and the in-page {@link WEBVIEW_CONTROLLER}
 * swaps it into `#live-root` WITHOUT reloading the document — so open collapsibles,
 * the active tab, and scroll position survive a data push (the whole point of the
 * near-real-time updates being non-disruptive).
 */
export function renderSessionDetailContent(
  detail: SessionDetail,
  turnDeviations: readonly (readonly WorkflowDeviation[])[],
  contextAnalysis?: SessionContextAnalysis,
  costMode: CostMode = 'aiu',
): string {
  const hasContext = contextAnalysis !== undefined;
  return `${hasContext ? `<nav class="tab-bar">
    <button class="tab-btn tab-btn-active" data-tab="tab-overview">Overview</button>
    <button class="tab-btn" data-tab="tab-context">Context Analysis</button>
  </nav>` : ''}
  <div class="tab-panel${hasContext ? '' : ' tab-panel-only'}" id="tab-overview">
  ${renderHeader(detail)}
  ${renderTreeSummary(detail.treeStats, detail.treeModelTurns, undefined, costMode)}
  ${renderMainAgentUsage(detail.agentUsage, costMode)}
  ${renderSubAgentUsage(detail.agentUsage, costMode)}
  ${renderTurns(detail.turns, turnDeviations)}
  </div>
  ${hasContext ? `<div class="tab-panel tab-panel-hidden" id="tab-context">${renderContextAnalysis(contextAnalysis)}</div>` : ''}`;
}

/**
 * Pure HTML renderer for the LOCAL combined-sessions webview.
 *
 * Same security model as {@link renderSessionDetailHtml}: every dynamic value is
 * {@link escapeHtml}-escaped, the document declares the strict nonce-only CSP, and
 * the page is static HTML (native `<details>` for collapsing). The layout is an
 * aggregate header + merged cost/token tables, then one collapsed `<details>`
 * section per session holding that session's meta, deviations, and turns (the
 * first section is open). All section helpers are shared with the single-session
 * renderer.
 */
export function renderCombinedSessionDetailHtml(
  view: CombinedSessionView,
  nonce: string,
  costMode: CostMode = 'aiu',
): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "font-src 'none'",
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Combined sessions (${num(view.combined.summary.sessionCount)})</title>
  <style nonce="${nonce}">${STYLE}</style>
</head>
<body>
  <div id="live-root">${renderCombinedSessionDetailContent(view, costMode)}</div>
  <script nonce="${nonce}">${WEBVIEW_CONTROLLER}</script>
</body>
</html>`;
}

/**
 * The mutable BODY of the combined view (aggregate header + merged tables +
 * per-session sections), WITHOUT the shell/styles/scripts — the combined
 * counterpart to {@link renderSessionDetailContent}, posted as an `update` on a
 * live/refresh re-render so the controller can swap it in without a reload.
 */
export function renderCombinedSessionDetailContent(
  view: CombinedSessionView,
  costMode: CostMode = 'aiu',
): string {
  const { combined, sections } = view;
  const sectionsHtml = sections
    .map((section, index) => renderSessionSection(section, index === 0, costMode, index))
    .join('\n');

  // The combined "Agent run totals" card mirrors the single-session one, over the
  // merged whole-tree stats. Its token trend is the sections' whole-tree model-turn
  // series concatenated in section order (the panel sorts sections by start time),
  // giving one continuous line across the selected sessions. `trendSessions` (the
  // short id + model-turn count of each section, same order) marks each scope.
  const mergedModelTurns = sections.flatMap((section) => section.detail.treeModelTurns);
  const trendSessions = sections.map((section) => ({
    label: shortId(section.detail.summary.sessionId),
    pointCount: section.detail.treeModelTurns.length,
  }));

  return `${renderCombinedHeader(combined.summary)}
  ${renderTreeSummary(combined.treeStats, mergedModelTurns, trendSessions, costMode)}
  ${renderMainAgentUsage(combined.agentUsage, costMode)}
  ${renderSubAgentUsage(combined.agentUsage, costMode)}
  <section class="panel">
    <div class="panel-heading"><h2>Sessions</h2><span>${num(sections.length)} session(s)</span></div>
    <div class="turns">${sectionsHtml}</div>
  </section>`;
}

/**
 * Combined-view header: the session count plus a thin temporal overview —
 * earliest start, latest end, and the wall-clock span between them — mirroring the
 * single-session {@link renderHeader}. Everything richer (repos, models, modes,
 * counts, tokens, AIU, cost) lives in the "Agent run totals" card, the "By model"
 * table, and the per-session sections below, so the header stays a temporal glance.
 */
function renderCombinedHeader(summary: CombinedSummary): string {
  return `<header class="header">
    <p class="eyebrow">Combined sessions</p>
    <h1>${num(summary.sessionCount)} sessions</h1>
    <dl class="meta">
      <div><dt>Started</dt><dd>${escapeHtml(formatLocal(summary.startedAtMs))}</dd></div>
      <div><dt>Ended</dt><dd>${escapeHtml(formatLocal(summary.endedAtMs))}</dd></div>
      <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(summary.spanMs))}</dd></div>
    </dl>
  </header>`;
}

/** One covered repository and how many of its sessions loaded into the aggregate. */
export interface RepositoryDetailSection {
  /** Sanitized repository URL (`https://host/owner/repo`) or the `unknown` bucket. */
  repository: string;
  /** Sessions of this repository successfully included in the merged totals. */
  sessionCount: number;
}

/**
 * Everything the repository-detail renderer needs, assembled by the panel: the
 * merged whole-tree rollups over EVERY session of the selected repository(ies),
 * plus which repositories are covered (so the combined view can say what it
 * aggregates) and what was left out — failed session loads and a source's
 * session cap are surfaced in the header, never dropped silently.
 */
export interface RepositoryDetailView {
  combined: CombinedSessionDetail;
  repositories: readonly RepositoryDetailSection[];
  /** Sessions that failed to load and are excluded from the totals. */
  failedSessions: number;
  /** The owning source's truncation note (e.g. Claude's most-recent-N cap). */
  truncationNote?: string;
}

/**
 * Pure HTML renderer for the LOCAL repository-detail webview: aggregate totals
 * over every session of one or more repositories. Same security model and live
 * shell as {@link renderSessionDetailHtml} (strict nonce-only CSP, everything
 * escaped, `#live-root` + controller for non-disruptive `update` messages).
 */
export function renderRepositoryDetailHtml(
  view: RepositoryDetailView,
  nonce: string,
  costMode: CostMode = 'aiu',
): string {
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "font-src 'none'",
  ].join('; ');
  const title =
    view.repositories.length === 1
      ? `Repository ${repoShortName(view.repositories[0].repository)}`
      : `Combined repositories (${view.repositories.length})`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <style nonce="${nonce}">${STYLE}</style>
</head>
<body>
  <div id="live-root">${renderRepositoryDetailContent(view, costMode)}</div>
  <script nonce="${nonce}">${WEBVIEW_CONTROLLER}</script>
</body>
</html>`;
}

/**
 * The mutable BODY of the repository view: header (which repositories, session
 * counts, exclusion notes) + the "Agent run totals" tiles + the merged main/sub-
 * agent tables. Deliberately NO token trend, dates/duration, timeline, or context
 * analysis — a repository aggregate is a totals card, not a run narrative. Posted
 * as an `update` message on live/refresh re-renders, like the session views.
 */
export function renderRepositoryDetailContent(view: RepositoryDetailView, costMode: CostMode = 'aiu'): string {
  return `${renderRepositoryHeader(view)}
  ${renderTreeSummaryTiles(view.combined.treeStats, costMode)}
  ${renderMainAgentUsage(view.combined.agentUsage, costMode)}
  ${renderSubAgentUsage(view.combined.agentUsage, costMode)}`;
}

/**
 * Repository-view header. The single-repo form names the repository; the combined
 * form counts them — and then lists every covered repository's full sanitized URL
 * with its included-session count, so a combined card always says exactly what it
 * aggregates. Exclusions (failed loads, source caps) are noted here too.
 */
function renderRepositoryHeader(view: RepositoryDetailView): string {
  const repos = view.repositories;
  const single = repos.length === 1;
  const sessions = (n: number): string => `${formatInt(n)} session${n === 1 ? '' : 's'}`;
  const rows = repos
    .map(
      (r) =>
        `<div><dt>${escapeHtml(r.repository)}</dt><dd>${sessions(r.sessionCount)}${single ? ' included' : ''}</dd></div>`,
    )
    .join('\n');
  const notes: string[] = [];
  if (view.failedSessions > 0) {
    notes.push(
      `<p class="muted">${formatInt(view.failedSessions)} session(s) could not be loaded and are excluded from these totals.</p>`,
    );
  }
  if (view.truncationNote !== undefined && view.truncationNote.length > 0) {
    notes.push(`<p class="muted">${escapeHtml(view.truncationNote)}</p>`);
  }
  return `<header class="header">
    <p class="eyebrow">${single ? 'Repository' : 'Combined repositories'}</p>
    <h1>${single ? escapeHtml(repoShortName(repos[0].repository)) : `${num(repos.length)} repositories`}</h1>
    <dl class="meta repo-list">
      ${rows}
    </dl>
    ${notes.join('\n')}
  </header>`;
}

/**
 * Compact display name for a sanitized repository URL: `https://host/owner/repo`
 * → `owner/repo` (last two path segments; the last one alone when there are
 * fewer). The `unknown` bucket gets a readable label. Display-only — the full URL
 * stays visible in the header's meta list (exported so the panel can title its
 * editor tab with the same name). Callers escape the result.
 */
export function repoShortName(repository: string): string {
  if (repository === UNKNOWN_REPOSITORY) {
    return 'Unknown repository';
  }
  const segments = repository
    .replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '')
    .split('/')
    .filter((s) => s.length > 0);
  if (segments.length === 0) {
    return repository;
  }
  return segments.slice(-2).join('/');
}

/**
 * One session's section in the combined view: a `<details>` (open when `open`)
 * whose summary is the session's id/title and headline counts, and whose body is
 * a compact meta line, the session's deviations, and its turns. Reuses the same
 * deviation/turn section helpers as the single-session renderer.
 */
function renderSessionSection(
  section: CombinedSessionSection,
  open: boolean,
  costMode: CostMode,
  index = 0,
): string {
  const { detail, turnDeviations } = section;
  const s = detail.summary;
  const id = escapeHtml(shortId(s.sessionId));
  const titleLabel =
    s.title !== undefined && s.title.length > 0
      ? `<span class="turn-label">${escapeHtml(truncate(s.title, 60))}</span>`
      : `<span class="turn-label">Session ${id}</span>`;
  // This session's cost: Copilot = whole-tree AIU at the fixed rate; Claude =
  // token-priced estimate carried on the tree stats.
  const costUsd =
    costMode === 'usd' ? formatUsdMicros(detail.treeStats.costUsdMicros) : null;
  const costLabel =
    costUsd !== null
      ? costUsd !== '$0.00'
        ? `<span class="turn-tokens">${costUsd}</span>`
        : ''
      : detail.treeStats.aiuNano > 0
        ? `<span class="turn-tokens">$${aiuToUsd(detail.treeStats.aiuNano).toFixed(2)}</span>`
        : '';
  const summaryRow =
    `<span class="time">${escapeHtml(formatTime(s.startedAtMs))}</span>${titleLabel}` +
    `<span class="mode">${id} · ${num(detail.turns.length)} turn(s) · ${num(s.llmCalls)} LLM · ${num(s.toolCalls)} tool</span>${costLabel}`;

  const meta = `<dl class="meta section-meta">
      <div><dt>Started</dt><dd>${escapeHtml(formatLocal(s.startedAtMs))}</dd></div>
      <div><dt>Ended</dt><dd>${escapeHtml(formatLocal(s.endedAtMs))}</dd></div>
      <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(s.durationMs))}</dd></div>
    </dl>`;

  return `<details class="turn-request session-section"${open ? ' open' : ''} data-k="s${num(index)}">
    <summary>${summaryRow}</summary>
    <div class="section-body">
      ${meta}
      ${renderTurns(detail.turns, turnDeviations, `s${num(index)}t`)}
    </div>
  </details>`;
}

/**
 * Sanitized session header: the session's name (same LOCAL-ONLY title the
 * Sessions list shows, falling back to the short id when no title is known)
 * and WHEN it ran (start / end / duration). The richer per-thread breakdown
 * (models, counts, tokens, cost) lives in the "By model" table and "Agent run
 * totals" card below, so the header stays a thin temporal overview.
 */
function renderHeader(detail: SessionDetail): string {
  const s = detail.summary;
  const title = s.title !== undefined && s.title.length > 0 ? s.title : undefined;
  // When titled, the id moves up into the eyebrow so it stays discoverable.
  const eyebrow = title !== undefined ? `Session · ${shortId(s.sessionId)}` : 'Session';
  const heading = title !== undefined ? truncate(title, 80) : shortId(s.sessionId);
  return `<header class="header">
    <p class="eyebrow">${escapeHtml(eyebrow)}</p>
    <h1>${escapeHtml(heading)}</h1>
    <dl class="meta">
      <div><dt>Started</dt><dd>${escapeHtml(formatLocal(s.startedAtMs))}</dd></div>
      <div><dt>Ended</dt><dd>${escapeHtml(formatLocal(s.endedAtMs))}</dd></div>
      <div><dt>Duration</dt><dd>${escapeHtml(formatDuration(s.durationMs))}</dd></div>
    </dl>
  </header>`;
}

/**
 * "Agent run totals" card: the whole-agent-tree rollup that mirrors GitHub's
 * per-session Agent Debug Logs summary, as a grid of stat tiles. Unlike the
 * header (main thread only), this INCLUDES every spawned sub-agent, so its
 * token/turn counts read larger by design — the note makes that explicit so the
 * smaller header totals are not mistaken for a discrepancy. AIU is GitHub's
 * actual billed unit ({@link formatAiu}); the values are all numeric and still
 * routed through {@link num}/{@link formatAiu} for defense-in-depth.
 */
function renderTreeSummary(
  stats: SessionTreeStats,
  modelTurns: readonly SessionModelTurnPoint[],
  trendSessions?: readonly TrendSession[],
  costMode: CostMode = 'aiu',
): string {
  return `<section class="panel">
    <div class="panel-heading"><h2>Agent run totals</h2><span>incl. spawned sub-agents</span></div>
    <div class="tree-row">
      ${renderTokenTrend(modelTurns, trendSessions)}
      <dl class="tree-totals">
        ${treeTotalsRows(stats, costMode)}
      </dl>
    </div>
  </section>`;
}

/**
 * The stat-tile rows of the "Agent run totals" card, shared by the session views
 * (beside the token trend) and the repository view (tiles only, no trend).
 */
function treeTotalsRows(stats: SessionTreeStats, costMode: CostMode): string {
  // Cost basis differs by source: Copilot shows AIU (with derived $); Claude
  // shows the token-priced USD estimate. Exactly one tile is rendered.
  const costTile =
    costMode === 'usd'
      ? { acr: 'COST', label: 'Estimated Cost (USD)', value: formatUsdMicros(stats.costUsdMicros) }
      : { acr: 'AIU', label: 'Copilot Usage (AIU)', value: formatAiu(stats.aiuNano) };
  // Flat right-aligned totals, each labelled by a short acronym (full name kept in
  // the `title` so the shorthand stays discoverable). TIN/TOUT/TCI = total
  // input/output/cached-input tokens; TT = total tokens; MT = model turns.
  const totals: Array<{ acr: string; label: string; value: string }> = [
    { acr: 'MT', label: 'Model Turns', value: formatInt(stats.modelTurns) },
    { acr: 'TC', label: 'Tool Calls', value: formatInt(stats.toolCalls) },
    { acr: 'TIN', label: 'Total Input Tokens', value: formatInt(stats.inputTokens) },
    { acr: 'TOUT', label: 'Total Output Tokens', value: formatInt(stats.outputTokens) },
    { acr: 'TCI', label: 'Total Cached Input Tokens', value: formatInt(stats.cachedTokens) },
    { acr: 'TT', label: 'Total Tokens', value: formatInt(stats.totalTokens) },
    { acr: 'ERR', label: 'Errors', value: formatInt(stats.errorCount) },
    costTile,
    { acr: 'LOC', label: 'Lines of Code (added)', value: formatInt(stats.linesOfCode) },
    { acr: 'LOD', label: 'Lines of Documentation (added)', value: formatInt(stats.linesOfDoc) },
    { acr: 'nLOC', label: 'Lines of Code (removed)', value: formatInt(stats.linesOfCodeRemoved) },
    { acr: 'nLOD', label: 'Lines of Documentation (removed)', value: formatInt(stats.linesOfDocRemoved) },
  ];
  return totals
    .map(
      (t) =>
        `<div class="tt-row"><dt title="${escapeHtml(t.label)}">${escapeHtml(t.acr)}</dt><dd>${t.value}</dd></div>`,
    )
    .join('\n');
}

/**
 * "Agent run totals" card without the token trend: just the stat tiles, spread
 * across the panel's width. Used by the repository view, which aggregates entire
 * repositories — a per-model-turn trend has no meaning there, so the tiles stand
 * alone rather than beside a plot.
 */
function renderTreeSummaryTiles(stats: SessionTreeStats, costMode: CostMode): string {
  return `<section class="panel">
    <div class="panel-heading"><h2>Agent run totals</h2><span>all sessions, incl. spawned sub-agents</span></div>
    <dl class="tree-totals tree-totals-grid">
      ${treeTotalsRows(stats, costMode)}
    </dl>
  </section>`;
}

/**
 * One session's contribution to the COMBINED token trend: its short session id and
 * how many consecutive model-turn points it owns in the merged series (the panel
 * concatenates sessions in start-time order). Drives the per-session scope dividers
 * and centered id labels overlaid on the trend; the single-session view passes none.
 */
interface TrendSession {
  /** Short session id shown centered over the session's scope. */
  label: string;
  /** Number of consecutive merged model-turn points this session owns (may be 0). */
  pointCount: number;
}

/**
 * Token + line-count totals for one plotted point of the trend, covering the model
 * turns {@link firstTurn}…{@link lastTurn} (a single turn when the series is plotted
 * one-per-turn, or a group of them when it is bucketed — see {@link GROUP_SIZE}).
 */
interface TrendPoint {
  input: number;
  cached: number;
  output: number;
  loc: number;
  lod: number;
  nloc: number;
  nlod: number;
  /** 1-based ordinal of the first model turn this point covers. */
  firstTurn: number;
  /** 1-based ordinal of the last model turn this point covers (=== firstTurn ungrouped). */
  lastTurn: number;
}

/**
 * Above this many model turns the trend buckets the series into groups of
 * {@link GROUP_SIZE} so a long run does not turn into hundreds of cramped points.
 */
const GROUP_THRESHOLD = 25;
/** Model turns per plotted point once {@link GROUP_THRESHOLD} is exceeded. */
const GROUP_SIZE = 5;

/** Sum a run of model turns into one plotted point spanning turns [first, last]. */
function sumModelTurns(
  group: readonly SessionModelTurnPoint[],
  firstTurn: number,
  lastTurn: number,
): TrendPoint {
  const p: TrendPoint = {
    input: 0,
    cached: 0,
    output: 0,
    loc: 0,
    lod: 0,
    nloc: 0,
    nlod: 0,
    firstTurn,
    lastTurn,
  };
  for (const mt of group) {
    p.input += mt.inputTokens;
    p.cached += mt.cachedTokens;
    p.output += mt.outputTokens;
    p.loc += mt.linesOfCode;
    p.lod += mt.linesOfDoc;
    p.nloc += mt.linesOfCodeRemoved;
    p.nlod += mt.linesOfDocRemoved;
  }
  return p;
}

/** Tooltip / axis caption for a point: a single turn number, or a turn range. */
function turnLabel(p: TrendPoint): string {
  return p.firstTurn === p.lastTurn ? `Turn ${p.firstTurn}` : `Turns ${p.firstTurn}–${p.lastTurn}`;
}

/**
 * Inline-SVG multi-line trend of the WHOLE-TREE token usage across MODEL TURNS:
 * one polyline each for input, cached, and output tokens, plotted over the run's
 * model turns (one x-position per tree `chat` span — see
 * {@link ../telemetry/models.SessionModelTurnPoint}). The x-axis is ORDINAL and
 * evenly spaced — labelled with the model-turn ORDINAL NUMBER (1-based), NOT a
 * clock time — so it stays gap-free and never implies a wall-clock scale. Fills the
 * rest of the "Agent run totals" row beside the flat totals list, and reconciles
 * with it (the points cover every one of the card's Model Turns).
 *
 * Beyond {@link GROUP_THRESHOLD} model turns the series is bucketed into groups of
 * {@link GROUP_SIZE} (token / line counts summed per group), so a long run stays
 * legible rather than collapsing into hundreds of cramped points. Each point's
 * tooltip and the x-axis then read as a turn RANGE (e.g. "Turns 1–5").
 *
 * When `sessions` is supplied (the COMBINED view, where `modelTurns` is the
 * sessions' point series concatenated), each session's scope is marked with a faint
 * vertical divider at its boundary and a centered short-id label; bucketing is done
 * WITHIN each session so a group never straddles a session boundary. The
 * single-session view passes none.
 *
 * CSP-safe: pure SVG with numeric geometry as presentation attributes and colours
 * applied via classes in the nonce'd `<style>` block — no inline `style=` (blocked
 * by `style-src 'nonce-…'`). The companion nonce'd script provides interactive
 * legend filtering with y-axis rescaling. All values are numeric and the only text
 * (session ids, turn numbers) is {@link escapeHtml}-escaped. With fewer than two
 * points there is nothing to plot, so a muted placeholder is shown instead.
 */
function renderTokenTrend(
  modelTurns: readonly SessionModelTurnPoint[],
  sessions?: readonly TrendSession[],
): string {
  // Session segments in model-turn-index space (combined view); the single-session
  // view is one segment spanning everything. Bucketing happens WITHIN a segment so a
  // group never crosses a session boundary and the dividers stay aligned.
  const segments: Array<{ label?: string; start: number; end: number }> = [];
  if (sessions !== undefined && sessions.length > 0) {
    let cursor = 0;
    for (const s of sessions) {
      if (s.pointCount > 0) {
        segments.push({ label: s.label, start: cursor, end: cursor + s.pointCount - 1 });
      }
      cursor += s.pointCount;
    }
  } else if (modelTurns.length > 0) {
    segments.push({ start: 0, end: modelTurns.length - 1 });
  }

  // One point per model turn normally; one per GROUP_SIZE once the run is long. The
  // decision is on the whole run's turn count, not per session.
  const bucketSize = modelTurns.length > GROUP_THRESHOLD ? GROUP_SIZE : 1;

  const points: TrendPoint[] = [];
  const ranges: Array<{ label: string; start: number; end: number }> = [];
  let turnsSoFar = 0;
  for (const seg of segments) {
    const segStart = points.length;
    for (let i = seg.start; i <= seg.end; i += bucketSize) {
      const groupEnd = Math.min(i + bucketSize - 1, seg.end);
      const group = modelTurns.slice(i, groupEnd + 1);
      points.push(sumModelTurns(group, turnsSoFar + 1, turnsSoFar + group.length));
      turnsSoFar += group.length;
    }
    if (seg.label !== undefined && points.length > segStart) {
      ranges.push({ label: seg.label, start: segStart, end: points.length - 1 });
    }
  }
  if (points.length < 2) {
    return `<div class="tree-trend tree-trend-empty"><p class="muted">Not enough model turns to plot a token trend.</p></div>`;
  }

  // Uniform-scaling viewBox (preserveAspectRatio default) so axis text is never
  // stretched. There is no y-axis scale — per-bucket values are read on hover (the
  // <title> tooltips below) — so only the bottom margin reserves space for the x
  // clock-time labels. All coordinates are numeric → safe to inject.
  const W = 600;
  const H = 200;
  const m = { top: 10, right: 12, bottom: 26, left: 12 };
  const innerW = W - m.left - m.right;
  const innerH = H - m.top - m.bottom;
  const baseline = m.top + innerH;
  const max = Math.max(1, ...points.flatMap((p) => [p.input, p.cached, p.output]));
  const x = (i: number): number => m.left + (innerW * i) / (points.length - 1);
  const y = (v: number): number => m.top + innerH - (innerH * v) / max;
  // Hover value labels are centre-anchored over their dot/stapel, but near the left or
  // right edge a centred number would spill past the viewBox and get clipped. Shift the
  // anchor x inward just enough that the whole label fits, estimating its half-width
  // from the character count (≈6 units/char at the 10px label font, an over-estimate so
  // commas never tip it over). Labels wider than the plot fall back to dead-centre.
  const labelX = (cx: number, text: string): string => {
    const halfW = (text.length * 6) / 2;
    const lo = m.left + halfW;
    const hi = W - m.right - halfW;
    const fitted = lo > hi ? (m.left + (W - m.right)) / 2 : Math.min(hi, Math.max(lo, cx));
    return fitted.toFixed(1);
  };
  // Vertical companion to `labelX`: labels are drawn ABOVE their dot/stapel and stacked
  // upward, so near the top edge the highest one would clip past the viewBox. `LABEL_TOP`
  // is the smallest baseline y (in viewBox units) that still keeps a label's glyphs and
  // halo fully inside. Callers floor the TOP-most label of a stack at it.
  const LABEL_TOP = 10;

  // Horizontal grid background (no value labels — the y-axis is intentionally
  // omitted; hover the chart to read exact numbers instead).
  const Y_TICKS = 4;
  const hGrid: string[] = [];
  for (let t = 0; t <= Y_TICKS; t++) {
    const gy = y((max * t) / Y_TICKS).toFixed(1);
    hGrid.push(
      `<line class="trend-grid" x1="${m.left}" y1="${gy}" x2="${W - m.right}" y2="${gy}" vector-effect="non-scaling-stroke" />`,
    );
  }

  // Vertical grid + x-axis labels: the 1-based MODEL-TURN NUMBER (not a clock time;
  // the last turn of the point's group when bucketed), thinned to at most ~8 columns
  // so long runs stay legible. The last point is always labelled. The axis is ordinal
  // — position is turn order, not elapsed time.
  const step = Math.max(1, Math.ceil(points.length / 8));
  const xGrid: string[] = [];
  points.forEach((p, i) => {
    if (i % step !== 0 && i !== points.length - 1) {
      return;
    }
    const gx = x(i).toFixed(1);
    xGrid.push(
      `<line class="trend-grid" x1="${gx}" y1="${m.top}" x2="${gx}" y2="${baseline.toFixed(1)}" vector-effect="non-scaling-stroke" />` +
        `<text class="trend-axis-label trend-axis-x" x="${gx}" y="${(baseline + 16).toFixed(1)}">${p.lastTurn}</text>`,
    );
  });

  // Solid x-axis line along the plot's bottom edge.
  const axis = `<line class="trend-axis" x1="${m.left}" y1="${baseline.toFixed(1)}" x2="${W - m.right}" y2="${baseline.toFixed(1)}" vector-effect="non-scaling-stroke" />`;

  // COMBINED view only: overlay each session's scope. `dividers` are faint vertical
  // lines at every boundary between consecutive sessions; `sessionLabels` are the
  // short session ids, horizontally centered within each session's stretch. `ranges`
  // (built above as inclusive bucket-index spans) holds one entry per session that
  // contributed buckets; sessions that contributed none are already excluded.
  let dividers = '';
  let sessionLabels = '';
  if (ranges.length > 0) {
    // Boundary x between range r-1 and r is the midpoint of their adjacent points;
    // the first range opens at the plot's left edge, the last closes at its right.
    const leftEdge = (r: number): number =>
      r === 0 ? m.left : (x(ranges[r - 1].end) + x(ranges[r].start)) / 2;
    const rightEdge = (r: number): number =>
      r === ranges.length - 1 ? W - m.right : (x(ranges[r].end) + x(ranges[r + 1].start)) / 2;

    const dividerLines: string[] = [];
    for (let r = 1; r < ranges.length; r++) {
      const bx = leftEdge(r).toFixed(1);
      dividerLines.push(
        `<line class="trend-session-divider" x1="${bx}" y1="${m.top}" x2="${bx}" y2="${baseline.toFixed(1)}" vector-effect="non-scaling-stroke" />`,
      );
    }
    dividers = dividerLines.join('\n');

    // Centered short-id label per session, just inside the top edge. Skipped when the
    // scope is too narrow for the text to read (keeps dense selections legible).
    const labelY = (m.top + 12).toFixed(1);
    sessionLabels = ranges
      .map((rg, r) => {
        const left = leftEdge(r);
        const right = rightEdge(r);
        if (right - left < 24) {
          return '';
        }
        const cx = ((left + right) / 2).toFixed(1);
        return `<text class="trend-session-label" x="${cx}" y="${labelY}">${escapeHtml(rg.label)}</text>`;
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }

  // Lines written/removed as two staplar (bars) per bucket: additions to the LEFT of
  // the bucket's x, removals to the RIGHT. They live on a SECONDARY scale — token
  // counts dwarf line counts, so reusing `max` would flatten the bars to nothing —
  // `linesMax` is an independent maximum over the per-turn stack totals. Both stacks
  // rise from the baseline (the colour, not the direction, distinguishes added from
  // removed; the "n" prefix on the removal labels already denotes negative lines, so
  // the COUNTS themselves are shown positive). `Math.max(1, …)` guards div-by-zero
  // and zero-height segments are omitted.
  const linesMax = Math.max(1, ...points.map((p) => Math.max(p.loc + p.lod, p.nloc + p.nlod)));
  const barH = (v: number): number => (innerH * v) / linesMax;
  const pitch = innerW / points.length;
  const barW = Math.min(8, Math.max(2, pitch * 0.3));
  const barGap = Math.max(1, barW * 0.3);
  // One stacked segment from cumulative `lower` to `upper` lines, at left edge `bx`.
  const barSeg = (bx: number, lower: number, upper: number, cls: string): string => {
    const h = barH(upper) - barH(lower);
    if (h <= 0) {
      return '';
    }
    return `<rect class="trend-bar ${cls}" x="${bx.toFixed(1)}" y="${(baseline - barH(upper)).toFixed(
      1,
    )}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" />`;
  };
  // Two count labels (code over doc) centered over a stapel, shown only while that
  // stapel is hovered (CSS `.trend-col:hover`). Drawn just above the stack top but
  // clamped inside the plot for tall bars; zero counts are omitted. Each tspan is
  // coloured to match its bar segment via `colourCls`.
  const barValue = (
    vx: number,
    stackTop: number,
    code: number,
    codeCls: string,
    doc: number,
    docCls: string,
  ): string => {
    // `lower` is the code (bottom) row's baseline; the doc row sits 11 above it. Floor
    // `lower` so the TOP-most present row (doc if any, else code) clears `LABEL_TOP`.
    const lower = Math.max(LABEL_TOP + (doc > 0 ? 11 : 0), stackTop - 4);
    const spans: string[] = [];
    if (doc > 0) {
      const docText = formatInt(doc);
      spans.push(
        `<tspan class="${docCls}" x="${labelX(vx, docText)}" y="${(lower - 11).toFixed(
          1,
        )}">${docText}</tspan>`,
      );
    }
    if (code > 0) {
      const codeText = formatInt(code);
      spans.push(
        `<tspan class="${codeCls}" x="${labelX(vx, codeText)}" y="${lower.toFixed(
          1,
        )}">${codeText}</tspan>`,
      );
    }
    return spans.length > 0 ? `<text class="trend-bar-value">${spans.join('')}</text>` : '';
  };
  // Each stapel is its own `.trend-col` group: the stacked segments, the on-hover
  // value labels, and a TRANSPARENT hit rect (last, so it sits on top and reliably
  // receives the hover). The hit rect exactly covers the RENDERED stapel — its width
  // and its stacked height — so hovering only the drawn bar highlights it, never the
  // empty space above or beside it. It carries the native <title> with every value at
  // that turn (removed counts positive). Rendered AFTER the polylines so hovering the
  // stapel highlights it and reveals its numbers; see the `.trend-col` rules in the
  // stylesheet. A zero-total stack draws no bar and so has no hit area.
  const barHit = (bx: number, total: number, title: string): string => {
    const h = barH(total);
    if (h <= 0) {
      return '';
    }
    return `<rect class="trend-col-hit" x="${bx.toFixed(1)}" y="${(baseline - h).toFixed(
      1,
    )}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}"><title>${title}</title></rect>`;
  };
  const bars = points
    .map((p, i) => {
      const cx = x(i);
      const addX = cx - barGap / 2 - barW;
      const remX = cx + barGap / 2;
      const title = `${turnLabel(p)} · Input ${formatInt(p.input)} · Cached ${formatInt(
        p.cached,
      )} · Output ${formatInt(p.output)} · LoC ${formatInt(p.loc)} · LoD ${formatInt(
        p.lod,
      )} · nLoC ${formatInt(p.nloc)} · nLoD ${formatInt(p.nlod)}`;
      const addGroup =
        `<g class="trend-col">` +
        barSeg(addX, 0, p.loc, 'trend-bar-loc') +
        barSeg(addX, p.loc, p.loc + p.lod, 'trend-bar-lod') +
        barValue(addX + barW / 2, baseline - barH(p.loc + p.lod), p.loc, 'trend-val-loc', p.lod, 'trend-val-lod') +
        barHit(addX, p.loc + p.lod, title) +
        `</g>`;
      const remGroup =
        `<g class="trend-col">` +
        barSeg(remX, 0, p.nloc, 'trend-bar-nloc') +
        barSeg(remX, p.nloc, p.nloc + p.nlod, 'trend-bar-nlod') +
        barValue(remX + barW / 2, baseline - barH(p.nloc + p.nlod), p.nloc, 'trend-val-nloc', p.nlod, 'trend-val-nlod') +
        barHit(remX, p.nloc + p.nlod, title) +
        `</g>`;
      return addGroup + remGroup;
    })
    .join('\n');

  const series: Array<{ key: 'input' | 'cached' | 'output'; label: string }> = [
    { key: 'input', label: 'Input' },
    { key: 'cached', label: 'Cached' },
    { key: 'output', label: 'Output' },
  ];
  const lines = series
    .map((s) => {
      const pts = points.map((p, i) => `${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`).join(' ');
      return `<polyline class="trend-line trend-${s.key}" points="${pts}" vector-effect="non-scaling-stroke" />`;
    })
    .join('\n');
  // Visible point markers, grouped per bucket so dots sitting close together share ONE
  // hover group: hovering any of them enlarges all and reveals ALL their numbers,
  // stacked upward so the labels don't collide. Dots far enough apart stay independent
  // (each its own `.trend-dot-col`). Within a group: the markers, the on-hover value
  // labels, and a transparent hit circle per dot (a touch larger than the marker so
  // the tiny dots are easily hoverable). See the `.trend-dot-col` rules in the
  // stylesheet.
  const DOT_CLUSTER_GAP = 11; // viewBox units; closer than this two dots' labels would overlap
  const DOT_LABEL_LINE = 11; // vertical spacing between stacked labels in a cluster
  const dots = points
    .map((p, i) => {
      const cxv = x(i);
      // This bucket's three series dots, sorted top-to-bottom (smallest y first).
      const ds = series
        .map((s) => ({ key: s.key, cy: y(p[s.key]), value: p[s.key] }))
        .sort((a, b) => a.cy - b.cy);
      // Partition into clusters of vertically-adjacent dots within the gap threshold.
      const clusters: Array<typeof ds> = [];
      for (const d of ds) {
        const last = clusters[clusters.length - 1];
        if (last && d.cy - last[last.length - 1].cy < DOT_CLUSTER_GAP) {
          last.push(d);
        } else {
          clusters.push([d]);
        }
      }
      return clusters
        .map((cluster) => {
          const topCy = cluster[0].cy;
          // Lowest label sits just above the cluster's top dot; the rest stack upward.
          // Floor the base so the highest label (j = n−1) still clears `LABEL_TOP`.
          const labelBase = Math.max(topCy - 7, LABEL_TOP + (cluster.length - 1) * DOT_LABEL_LINE);
          const markers = cluster
            .map(
              (d) =>
                `<circle class="trend-dot trend-${d.key}" cx="${cxv.toFixed(1)}" cy="${d.cy.toFixed(
                  1,
                )}" r="2.2" />`,
            )
            .join('');
          // Stack labels upward from just above the cluster's top dot, clamped inside
          // the plot, so every number in the cluster stays readable.
          const labels = cluster
            .map((d, j) => {
              const ly = labelBase - j * DOT_LABEL_LINE;
              const text = formatInt(d.value);
              return `<text class="trend-dot-value trend-dot-val-${d.key}" x="${labelX(
                cxv,
                text,
              )}" y="${ly.toFixed(1)}">${text}</text>`;
            })
            .join('');
          const hits = cluster
            .map(
              (d) =>
                `<circle class="trend-dot-hit" cx="${cxv.toFixed(1)}" cy="${d.cy.toFixed(
                  1,
                )}" r="5" />`,
            )
            .join('');
          return `<g class="trend-dot-col">${markers}${labels}${hits}</g>`;
        })
        .join('');
    })
    .join('\n');
  // Token-line keys plus the four line-count bar keys (additions then removals).
  const barKeys: Array<{ key: string; label: string }> = [
    { key: 'loc', label: 'LoC' },
    { key: 'lod', label: 'LoD' },
    { key: 'nloc', label: 'LoC removed' },
    { key: 'nlod', label: 'LoD removed' },
  ];
  const allKeys = [
    ...series.map((s) => ({ key: s.key, label: s.label })),
    ...barKeys,
  ];
  const legend =
    allKeys
      .map(
        (s) =>
          `<span class="trend-key" data-series="${s.key}" role="button" tabindex="0"><span class="trend-swatch trend-${s.key}"></span>${s.label}</span>`,
      )
      .join('') +
    `<span class="trend-reset" role="button" tabindex="0">Reset filter</span>` +
    // When bucketed, make the grouping explicit so a point reading "Turns 1–5" is
    // understood as a sum, not a single turn.
    (bucketSize > 1
      ? `<span class="trend-key trend-group-note">grouped by ${GROUP_SIZE} model turns</span>`
      : '');

  // Embed the point data for the filter script to rescale the y-axis dynamically.
  const trendData = JSON.stringify(
    points.map((p) => ({
      input: p.input,
      cached: p.cached,
      output: p.output,
      loc: p.loc,
      lod: p.lod,
      nloc: p.nloc,
      nlod: p.nlod,
    })),
  );

  return `<div class="tree-trend" data-trend-points="${escapeHtml(trendData)}">
    <svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Whole-tree token usage and lines written per model turn">
      ${hGrid.join('\n')}
      ${xGrid.join('\n')}
      ${dividers}
      ${axis}
      ${lines}
      <g class="trend-dots">${dots}</g>
      ${bars}
      ${sessionLabels}
    </svg>
    <div class="trend-legend">${legend}</div>
  </div>`;
}

/**
 * "Main agent" table: the MAIN-THREAD per-(agent, model) usage — `agentUsage` rows
 * of kind `main`. Same columns as {@link renderSubAgentUsage} so the two read as a
 * pair. Rendered only when there is at least one main-thread row. The whole-run
 * total (incl. sub-agents) lives in the "Agent run totals" card, so this table
 * carries only its own subtotal.
 */
function renderMainAgentUsage(usage: readonly SessionAgentUsage[], costMode: CostMode): string {
  return renderAgentUsage(
    usage.filter((u) => u.kind === 'main'),
    {
      heading: 'Main agent',
      countNoun: 'model',
      footerLabel: 'Total',
      callsTitle: 'Main-thread model turns (chat spans) for this model',
    },
    costMode,
  );
}

/**
 * "Spawned sub-agents" breakdown: one row per (agent, model) the main agent
 * launched via a `runSubagent` tool call (the `agentUsage` rows of kind
 * `subagent`). Rendered only when the session spawned at least one sub-agent. Each
 * row shows the sub-agent's real tokens AND AIU, read from its own `chat` spans.
 */
function renderSubAgentUsage(usage: readonly SessionAgentUsage[], costMode: CostMode): string {
  return renderAgentUsage(
    usage.filter((u) => u.kind === 'subagent'),
    {
      heading: 'Spawned sub-agents',
      countNoun: 'invocation group',
      footerLabel: 'Sub-agent total',
      callsTitle: 'Model turns (chat spans) for this sub-agent',
      note:
        'Sub-agents this session spawned, with the real tokens and cost recorded on their own model turns. The whole-run rollup is in the "Agent run totals" card above.',
    },
    costMode,
  );
}

/**
 * Shared renderer for a per-(agent, model) usage table — used for both the main
 * thread and the spawned sub-agents so they share one column layout (Agent, Model,
 * Calls, Input, Output, Cached, AIU). The AIU column is the actual billed figure
 * and carries the derived dollar cost inline ({@link formatAiu}); the footer is
 * this table's own subtotal. Returns `''` when there are no rows.
 */
function renderAgentUsage(
  rows: readonly SessionAgentUsage[],
  opts: { heading: string; countNoun: string; footerLabel: string; callsTitle: string; note?: string },
  costMode: CostMode,
): string {
  if (rows.length === 0) {
    return '';
  }

  const totals = rows.reduce(
    (acc, u) => {
      acc.llmCalls += u.llmCalls;
      acc.inputTokens += u.inputTokens;
      acc.outputTokens += u.outputTokens;
      acc.cachedTokens += u.cachedTokens;
      acc.aiuNano += u.aiuNano;
      acc.costUsdMicros += u.costUsdMicros ?? 0;
      acc.linesOfCode += u.linesOfCode;
      acc.linesOfDoc += u.linesOfDoc;
      acc.linesOfCodeRemoved += u.linesOfCodeRemoved;
      acc.linesOfDocRemoved += u.linesOfDocRemoved;
      return acc;
    },
    {
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      aiuNano: 0,
      costUsdMicros: 0,
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    },
  );

  // One cost column: AIU (Copilot) or estimated USD (Claude).
  const costCell = (u: SessionAgentUsage): string =>
    costMode === 'usd' ? formatUsdMicros(u.costUsdMicros) : formatAiu(u.aiuNano);
  const costFooter =
    costMode === 'usd' ? formatUsdMicros(totals.costUsdMicros) : formatAiu(totals.aiuNano);
  const costHeader =
    costMode === 'usd'
      ? '<th class="n" title="Estimated USD cost for these model turns (token×rate)">Cost</th>'
      : '<th class="n" title="AIU (Copilot premium-request units) recorded on these spans — the actual billed usage — with the derived cost at $0.01/AIU">AIU</th>';

  const bodyRows = rows
    .map(
      (u) => `<tr>
        <td>${escapeHtml(u.agentName)}</td>
        <td class="model">${escapeHtml(u.model)}</td>
        <td class="n">${num(u.llmCalls)}</td>
        <td class="n">${num(u.inputTokens)}</td>
        <td class="n">${num(u.outputTokens)}</td>
        <td class="n">${num(u.cachedTokens)}</td>
        <td class="n">${costCell(u)}</td>
        <td class="n">${num(u.linesOfCode)}</td>
        <td class="n">${num(u.linesOfDoc)}</td>
        <td class="n">${num(u.linesOfCodeRemoved)}</td>
        <td class="n">${num(u.linesOfDocRemoved)}</td>
      </tr>`,
    )
    .join('\n');

  const note = opts.note !== undefined ? `\n    <p class="muted">${opts.note}</p>` : '';

  return `<section class="panel">
    <div class="panel-heading"><h2>${escapeHtml(opts.heading)}</h2><span>${num(rows.length)} ${escapeHtml(opts.countNoun)}(s)</span></div>${note}
    <table>
      <thead>
        <tr>
          <th>Agent</th><th>Model</th><th class="n" title="${escapeHtml(opts.callsTitle)}">Calls</th><th class="n">Input</th>
          <th class="n">Output</th><th class="n">Cached</th>
          ${costHeader}
          <th class="n" title="Lines of Code added to source-code files by this agent/model's file-writing tool calls">LoC</th>
          <th class="n" title="Lines of Documentation added to doc files by this agent/model's file-writing tool calls">LoD</th>
          <th class="n" title="Lines of Code removed from source-code files by this agent/model's file-writing tool calls">nLoC</th>
          <th class="n" title="Lines of Documentation removed from doc files by this agent/model's file-writing tool calls">nLoD</th>
        </tr>
      </thead>
      <tbody>
        ${bodyRows}
      </tbody>
      <tfoot>
        <tr>
          <td>${escapeHtml(opts.footerLabel)}</td>
          <td class="model"></td>
          <td class="n">${num(totals.llmCalls)}</td>
          <td class="n">${num(totals.inputTokens)}</td>
          <td class="n">${num(totals.outputTokens)}</td>
          <td class="n">${num(totals.cachedTokens)}</td>
          <td class="n">${costFooter}</td>
          <td class="n">${num(totals.linesOfCode)}</td>
          <td class="n">${num(totals.linesOfDoc)}</td>
          <td class="n">${num(totals.linesOfCodeRemoved)}</td>
          <td class="n">${num(totals.linesOfDocRemoved)}</td>
        </tr>
      </tfoot>
    </table>
  </section>`;
}

/**
 * Per-turn workflow-divergence chips, rendered at the TOP of a turn so a relevant
 * workflow whose steps were skipped or ran out of order is visible without
 * expanding the request. Returns '' when the turn has no divergences (the common
 * case — the timeline stays quiet). Reuses the `.deviation`/`.badge` styling. A
 * content-derived divergence is flagged "Local only" (never eligible for sync).
 */
function renderTurnDeviations(deviations: readonly WorkflowDeviation[]): string {
  if (deviations.length === 0) {
    return '';
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

  return `<div class="turn-deviations" role="alert">${cards}</div>`;
}

/**
 * Timeline grouped into per-user-request turns. Each turn is a top-level block
 * with two collapsed `<details>`: the User Request (which itself nests the
 * collapsible event timeline) and the Final LLM Response.
 */
function renderTurns(
  turns: readonly SessionTurn[],
  turnDeviations: readonly (readonly WorkflowDeviation[])[] = [],
  keyPrefix = 't',
): string {
  const blocks = turns
    .map((turn, i) => renderTurn(turn, turnDeviations[i] ?? [], `${keyPrefix}${i}`))
    .join('\n');
  const issues = turnDeviations.reduce((total, list) => total + list.length, 0);
  const heading =
    issues > 0
      ? `${num(turns.length)} turn(s) · ${num(issues)} workflow divergence(s)`
      : `${num(turns.length)} turn(s)`;
  return `<section class="panel">
    <div class="panel-heading"><h2>Timeline</h2><span>${heading}</span></div>
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
export function renderTurn(
  turn: SessionTurn,
  deviations: readonly WorkflowDeviation[] = [],
  key = 't0',
): string {
  const time = escapeHtml(formatTime(turn.timestampMs));
  const events = turn.events.map(renderTimelineRow).join('\n');
  const timeline = `<details class="timeline-disclosure" data-k="${escapeHtml(key)}l"><summary>Timeline (${num(
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
  const request = `<details class="turn-request" data-k="${escapeHtml(key)}r"><summary>${requestSummary}</summary>${requestBody}</details>`;

  const response =
    turn.finalResponse !== undefined && turn.finalResponse.length > 0
      ? `<details class="turn-response" data-k="${escapeHtml(key)}p"><summary><span class="turn-label">Final LLM response</span></summary><pre>${escapeHtml(
          turn.finalResponse,
        )}</pre></details>`
      : '';

  return `<div class="turn">
    ${renderTurnDeviations(deviations)}
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
 * Format premium-request usage held as integer NANO-AIU (1 AIU = 1e9) for display.
 * This is GitHub's ACTUAL billed unit, so the derived dollar cost is always shown
 * inline at the fixed rate ({@link ../telemetry/pricing.aiuToUsd}, $0.01/AIU) —
 * e.g. `536.26 ($5.36)`. Zero/absent → `0` (honest: not billed, never `n/a`).
 * Small AIU values get extra precision on the unit figure. The output is digits
 * and `$.()` only, so it is safe to inject without escaping (it never derives from
 * user content).
 */
function formatAiu(aiuNano: number): string {
  if (!(aiuNano > 0)) {
    return '0';
  }
  const aiu = aiuNano / 1_000_000_000;
  const value = aiu.toFixed(aiu < 1 ? 4 : 2);
  return `${value} ($${aiuToUsd(aiuNano).toFixed(2)})`;
}

/** Collapse whitespace and truncate a label to `max` chars with an ellipsis. */
function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max)}…` : collapsed;
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

// ─── Context Analysis Rendering ────────────────────────────────────────────────

/**
 * Render the full context analysis tab content: a series of collapsible sections
 * (Total Overview, Main Agent, Subagent A, B, ...).
 */
function renderContextAnalysis(analysis: SessionContextAnalysis): string {
  const sections: string[] = [];

  // Optional provenance caption (e.g. the Claude disk-state caveat).
  if (analysis.note !== undefined && analysis.note.length > 0) {
    sections.push(`<p class="ctx-note">${escapeHtml(analysis.note)}</p>`);
  }

  // Total Overview (open by default)
  sections.push(renderAgentContextSection(analysis.total, true, 0));

  // Per-agent sections (collapsed by default)
  analysis.agents.forEach((agent, i) => {
    sections.push(renderAgentContextSection(agent, false, i + 1));
  });

  return `<div class="context-analysis">${sections.join('\n')}</div>`;
}

/**
 * Render one agent's context analysis as a collapsible `<details>` section.
 */
function renderAgentContextSection(agent: AgentContextAnalysis, open: boolean, index = 0): string {
  const kindBadge = agent.kind === 'total'
    ? ''
    : `<span class="ctx-badge ctx-badge-${agent.kind}">${escapeHtml(agent.kind)}</span>`;

  const fileCount = agent.loadedFiles.filter((f) => f.status !== 'skipped').length;
  const countLabel = `${num(fileCount)} file(s) in context`;

  return `<details class="ctx-section"${open ? ' open' : ''} data-k="c${num(index)}">
  <summary class="ctx-section-summary">
    <span class="ctx-section-title">${escapeHtml(agent.agentName)}</span>
    ${kindBadge}
    <span class="ctx-section-count">${countLabel}</span>
  </summary>
  <div class="ctx-section-body">
    ${renderContextBudget(agent)}
    ${renderLoadedFilesTable(agent)}
    ${renderExpectedMissing(agent)}
    ${renderOversizedCallouts(agent)}
  </div>
</details>`;
}

/**
 * Render the context budget bar (context files vs other context).
 */
function renderContextBudget(agent: AgentContextAnalysis): string {
  if (agent.totalContextTokens <= 0) {
    return '';
  }

  const contextPct = Math.min(100, Math.round((agent.contextFileTokens / agent.totalContextTokens) * 100));
  const otherPct = 100 - contextPct;

  return `<div class="ctx-budget">
  <div class="ctx-budget-heading">
    <span class="eyebrow">Context window usage</span>
    <span class="muted">${formatInt(agent.totalContextTokens)} est. input tokens</span>
  </div>
  <div class="ctx-budget-bar">
    <div class="ctx-budget-fill ctx-budget-files ctx-w-${contextPct}"></div>
    <div class="ctx-budget-fill ctx-budget-other ctx-w-${otherPct}"></div>
  </div>
  <div class="ctx-budget-legend">
    <span class="ctx-budget-legend-item"><span class="ctx-swatch ctx-swatch-files"></span> Context files: ${num(contextPct)}% (${formatInt(agent.contextFileTokens)} tokens)</span>
    <span class="ctx-budget-legend-item"><span class="ctx-swatch ctx-swatch-other"></span> Other (system prompt, tools, history): ${num(otherPct)}%</span>
  </div>
</div>`;
}

/**
 * Render a context file's display name: a link that opens the file in the editor
 * when its on-disk path is known, plain text otherwise (some Copilot discovery
 * events carry names only).
 */
function ctxFileName(f: ContextFileEntry): string {
  if (f.filePath === undefined || f.filePath.length === 0) {
    return escapeHtml(f.name);
  }
  return `<a href="#" class="ctx-file-link" data-path="${escapeHtml(f.filePath)}" title="${escapeHtml(f.filePath)}">${escapeHtml(f.name)}</a>`;
}

/**
 * Render the loaded files table.
 */
function renderLoadedFilesTable(agent: AgentContextAnalysis): string {
  const files = agent.loadedFiles;
  if (files.length === 0) {
    return '<p class="muted">No context files detected.</p>';
  }

  // Sort: applied/read first, then by estimated tokens descending
  const sorted = [...files].sort((a, b) => {
    const statusOrder = (s: string) => (s === 'applied' ? 0 : s === 'read' ? 1 : 2);
    const sd = statusOrder(a.status) - statusOrder(b.status);
    if (sd !== 0) return sd;
    return (b.estimatedTokens ?? 0) - (a.estimatedTokens ?? 0);
  });

  const rows = sorted.map((f) => {
    const isOversized = agent.oversizedFiles.some((o) => o.name === f.name);
    const indicator = isOversized ? ' <span class="ctx-warn" title="Oversized — consider reducing">⚠️</span>' : '';
    const statusClass = `ctx-status-${f.status}`;
    const tokensStr = f.estimatedTokens !== undefined ? formatInt(f.estimatedTokens) : '—';
    const skipInfo = f.skipReason ? ` <span class="muted ctx-skip-reason">(${escapeHtml(truncate(f.skipReason, 60))})</span>` : '';

    return `<tr>
      <td>${ctxFileName(f)}${indicator}${skipInfo}</td>
      <td><span class="ctx-category">${escapeHtml(f.category)}</span></td>
      <td class="n">${tokensStr}</td>
      <td><span class="${statusClass}">${escapeHtml(f.status)}</span></td>
    </tr>`;
  }).join('\n');

  return `<div class="ctx-files-section">
  <h3>Loaded context files</h3>
  <table class="ctx-table">
    <thead><tr><th>Name</th><th>Category</th><th class="n">Est. Tokens</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

/**
 * Render expected-but-missing files section.
 */
function renderExpectedMissing(agent: AgentContextAnalysis): string {
  if (agent.expectedMissing.length === 0) {
    return '';
  }

  const rows = agent.expectedMissing.map((m) => {
    const referencedBy = m.referencedBy
      .map((r) => `<span class="ctx-accept-source" data-source="${escapeHtml(r.sourceFile)}" title="Accept all missing references from this file">${escapeHtml(r.sourceFile)}</span>`)
      .join(', ');
    const refType = m.referencedBy[0]?.referenceType ?? 'unknown';

    return `<tr>
      <td><span class="ctx-accept-file" data-file="${escapeHtml(m.name)}" title="Accept this file as missing">${escapeHtml(m.name)}</span></td>
      <td>${referencedBy}</td>
      <td><span class="ctx-ref-type">${escapeHtml(refType)}</span></td>
      <td>
        <button class="ctx-accept-btn" data-accept-file="${escapeHtml(m.name)}" title="Accept this file as missing">✓</button>
      </td>
    </tr>`;
  }).join('\n');

  return `<div class="ctx-missing-section">
  <h3>Expected but missing</h3>
  <p class="muted">These files are referenced by loaded context files but were not loaded into context.</p>
  <table class="ctx-table">
    <thead><tr><th>Name</th><th>Referenced By</th><th>Ref. Type</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
}

/**
 * Render oversized file callouts.
 */
function renderOversizedCallouts(agent: AgentContextAnalysis): string {
  if (agent.oversizedFiles.length === 0) {
    return '';
  }

  const cards = agent.oversizedFiles.map((f) => {
    const tokens = f.estimatedTokens ?? 0;
    return `<div class="ctx-oversized-card">
      <span class="ctx-oversized-icon">⚠️</span>
      <div class="ctx-oversized-info">
        <strong>${ctxFileName(f)}</strong>
        <span class="muted">~${formatInt(tokens)} tokens — consider splitting or trimming this file</span>
      </div>
    </div>`;
  }).join('\n');

  return `<div class="ctx-oversized-section">
  <h3>Oversized context files</h3>
  ${cards}
</div>`;
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
  .repo-list dt { text-transform: none; letter-spacing: normal; }
  .panel { border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); border-radius: 6px; padding: .75rem .9rem; margin-bottom: 1rem; background: var(--vscode-editorWidget-background); }
  .panel-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 1rem; margin-bottom: .5rem; }
  .panel-heading span { color: var(--vscode-descriptionForeground); font-size: .8rem; }
  .tree-row { display: flex; gap: 1rem; align-items: stretch; margin: .5rem 0 0; }
  .tree-trend { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: .4rem; }
  .tree-trend-empty { align-items: center; justify-content: center; border: 1px dashed var(--vscode-panel-border, var(--vscode-editorWidget-border)); border-radius: 5px; padding: 1rem; }
  .trend-svg { width: 100%; height: auto; display: block; }
  .trend-line { fill: none; stroke-width: 1.5px; transition: opacity .15s ease; }
  .trend-line.trend-hidden { opacity: 0; pointer-events: none; }
  .trend-line.trend-input { stroke: var(--vscode-charts-blue, #4e94ce); }
  .trend-line.trend-cached { stroke: var(--vscode-charts-yellow, #b89500); }
  .trend-line.trend-output { stroke: var(--vscode-charts-green, #388a34); }
  .trend-grid { stroke: var(--vscode-panel-border, var(--vscode-editorWidget-border)); stroke-width: 1px; opacity: .45; }
  .trend-axis { stroke: var(--vscode-descriptionForeground); stroke-width: 1px; opacity: .8; }
  .trend-axis-label { fill: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); font-size: 11px; }
  .trend-axis-x { text-anchor: middle; }
  .trend-session-divider { stroke: var(--vscode-descriptionForeground); stroke-width: 1px; stroke-dasharray: 3 3; opacity: .35; }
  .trend-session-label { fill: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); font-size: 10px; text-anchor: middle; opacity: .6; }
  .trend-dot.trend-input { fill: var(--vscode-charts-blue, #4e94ce); }
  .trend-dot.trend-cached { fill: var(--vscode-charts-yellow, #b89500); }
  .trend-dot.trend-output { fill: var(--vscode-charts-green, #388a34); }
  .trend-dot { transition: r .08s ease; }
  .trend-dot-col { cursor: crosshair; }
  .trend-dot-hit { fill: transparent; pointer-events: all; }
  .trend-dot-col:hover .trend-dot { r: 3.6; }
  .trend-dot-value { opacity: 0; text-anchor: middle; font-family: var(--vscode-font-family); font-size: 10px; font-weight: 600; paint-order: stroke; stroke: var(--vscode-editor-background, var(--vscode-editorWidget-background)); stroke-width: 3px; stroke-linejoin: round; }
  .trend-dot-col:hover .trend-dot-value { opacity: 1; }
  .trend-dot-val-input { fill: var(--vscode-charts-blue, #4e94ce); }
  .trend-dot-val-cached { fill: var(--vscode-charts-yellow, #b89500); }
  .trend-dot-val-output { fill: var(--vscode-charts-green, #388a34); }
  .trend-bar { opacity: .55; transition: opacity .15s ease; }
  .trend-bar.trend-bar-hidden { opacity: 0; pointer-events: none; }
  .trend-bar.trend-bar-loc { fill: var(--vscode-charts-purple, #b180d7); }
  .trend-bar.trend-bar-lod { fill: var(--vscode-charts-orange, #d18616); }
  .trend-bar.trend-bar-nloc { fill: var(--vscode-charts-red, #be1100); }
  .trend-bar.trend-bar-nlod { fill: #e07b86; }
  .trend-col { cursor: crosshair; }
  .trend-col.trend-col-hidden { opacity: 0; pointer-events: none; }
  .trend-col-hit { fill: transparent; pointer-events: all; }
  .trend-col:hover .trend-col-hit { fill: var(--vscode-list-hoverBackground, var(--vscode-foreground)); opacity: .12; }
  .trend-col:hover .trend-bar { opacity: 1; }
  .trend-bar-value { opacity: 0; text-anchor: middle; font-family: var(--vscode-font-family); font-size: 10px; font-weight: 600; paint-order: stroke; stroke: var(--vscode-editor-background, var(--vscode-editorWidget-background)); stroke-width: 3px; stroke-linejoin: round; }
  .trend-col:hover .trend-bar-value { opacity: 1; }
  .trend-val-loc { fill: var(--vscode-charts-purple, #b180d7); }
  .trend-val-lod { fill: var(--vscode-charts-orange, #d18616); }
  .trend-val-nloc { fill: var(--vscode-charts-red, #be1100); }
  .trend-val-nlod { fill: #d6409a; }
  .trend-legend { display: flex; flex-wrap: wrap; gap: .9rem; font-size: .75rem; color: var(--vscode-descriptionForeground); align-items: center; }
  .trend-key { display: inline-flex; align-items: center; gap: .3rem; cursor: pointer; border-radius: 3px; padding: .1rem .3rem; transition: opacity .12s ease, background .12s ease; }
  .trend-key:hover { background: var(--vscode-list-hoverBackground, rgba(128,128,128,.1)); }
  .trend-key.trend-key-active { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .trend-key.trend-key-dimmed { opacity: .35; }
  .trend-reset { display: none; cursor: pointer; font-size: .7rem; font-weight: 600; padding: .15rem .45rem; border-radius: 3px; background: var(--vscode-button-secondaryBackground, rgba(128,128,128,.2)); color: var(--vscode-button-secondaryForeground, var(--vscode-foreground)); transition: background .1s ease; }
  .trend-reset:hover { background: var(--vscode-button-secondaryHoverBackground, rgba(128,128,128,.35)); }
  .trend-reset.trend-reset-visible { display: inline-flex; }
  .trend-group-note { margin-left: auto; font-style: italic; opacity: .8; }
  .trend-swatch { width: .7rem; height: .7rem; border-radius: 2px; display: inline-block; }
  .trend-swatch.trend-input { background: var(--vscode-charts-blue, #4e94ce); }
  .trend-swatch.trend-cached { background: var(--vscode-charts-yellow, #b89500); }
  .trend-swatch.trend-output { background: var(--vscode-charts-green, #388a34); }
  .trend-swatch.trend-loc { background: var(--vscode-charts-purple, #b180d7); }
  .trend-swatch.trend-lod { background: var(--vscode-charts-orange, #d18616); }
  .trend-swatch.trend-nloc { background: var(--vscode-charts-red, #be1100); }
  .trend-swatch.trend-nlod { background: #d6409a; }
  .tree-totals { flex: 0 0 20%; display: flex; flex-direction: column; gap: .3rem; margin: 0; text-align: right; }
  .tree-totals .tt-row { display: flex; justify-content: space-between; align-items: baseline; gap: .5rem; padding-bottom: .15rem; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  .tree-totals .tt-row:last-child { border-bottom: none; }
  .tree-totals dt { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .tree-totals dd { margin: 0; font-variant-numeric: tabular-nums; font-weight: 600; }
  .tree-totals-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: .3rem 1.2rem; margin-top: .5rem; }
  .deviation-list { display: flex; flex-direction: column; gap: .6rem; }
  .deviation { border-left: 3px solid var(--vscode-editorWarning-foreground, #c90); padding: .4rem .6rem; background: var(--vscode-inputValidation-warningBackground, transparent); border-radius: 0 4px 4px 0; }
  .deviation p { margin: .3rem 0; }
  .deviation-head { display: flex; align-items: center; gap: .5rem; }
  .badge { display: inline-block; font-size: .7rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: .1rem .4rem; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .badge-local { background: var(--vscode-inputValidation-warningBackground, transparent); color: var(--vscode-editorWarning-foreground, #c90); border: 1px solid var(--vscode-editorWarning-foreground, #c90); }
  .seq { font-size: .82rem; color: var(--vscode-descriptionForeground); }
  .turn-deviations { display: flex; flex-direction: column; gap: .4rem; padding: .5rem .6rem; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  table { width: 100%; border-collapse: collapse; font-size: .85rem; }
  th, td { text-align: left; padding: .3rem .5rem; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  thead th { font-size: .72rem; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); font-weight: 600; }
  td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
  td.model { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
  tfoot td { font-weight: 600; border-bottom: none; border-top: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  .section-body { padding: 0 .6rem .6rem; }
  .section-body .panel { background: transparent; }
  .section-meta { margin: .6rem 0; }
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

  /* ─── Tab navigation ───────────────────────────────────── */
  .tab-bar { display: flex; gap: 0; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); margin-bottom: 1rem; position: sticky; top: 0; z-index: 10; background: var(--vscode-editor-background); }
  .tab-btn { background: none; border: none; border-bottom: 2px solid transparent; color: var(--vscode-descriptionForeground); font-family: var(--vscode-font-family); font-size: .85rem; font-weight: 500; padding: .6rem 1rem; cursor: pointer; transition: color .12s, border-color .12s; }
  .tab-btn:hover { color: var(--vscode-foreground); }
  .tab-btn-active { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder, var(--vscode-textLink-foreground)); font-weight: 600; }
  .tab-panel-hidden { display: none; }
  .tab-panel-only { display: block; }

  /* ─── Context Analysis ─────────────────────────────────── */
  .context-analysis { display: flex; flex-direction: column; gap: .75rem; }
  .ctx-note { margin: 0; padding: .5rem .7rem; font-size: .78rem; line-height: 1.45; color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background, var(--vscode-editorWidget-background)); border-left: 3px solid var(--vscode-textBlockQuote-border, var(--vscode-panel-border)); border-radius: 3px; }
  .ctx-section { border: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); border-radius: 6px; overflow: hidden; }
  .ctx-section-summary { cursor: pointer; display: flex; align-items: center; gap: .65rem; padding: .55rem .8rem; list-style: none; background: var(--vscode-editorWidget-background); }
  .ctx-section-summary::-webkit-details-marker { display: none; }
  .ctx-section-summary::before { content: '▸'; color: var(--vscode-descriptionForeground); font-size: .8rem; }
  .ctx-section[open] > .ctx-section-summary::before { content: '▾'; }
  .ctx-section-summary:hover { background: var(--vscode-list-hoverBackground, transparent); }
  .ctx-section-title { font-weight: 600; }
  .ctx-section-count { margin-left: auto; font-size: .78rem; color: var(--vscode-descriptionForeground); }
  .ctx-section-body { padding: .6rem .8rem; display: flex; flex-direction: column; gap: .8rem; }
  .ctx-section-body h3 { font-size: .9rem; margin: 0 0 .3rem; }
  .ctx-badge { font-size: .65rem; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; padding: .1rem .35rem; border-radius: 3px; }
  .ctx-badge-main { background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .ctx-badge-subagent { background: var(--vscode-inputValidation-infoBackground, transparent); color: var(--vscode-inputValidation-infoForeground, var(--vscode-foreground)); border: 1px solid var(--vscode-inputValidation-infoBorder, var(--vscode-panel-border)); }
  .ctx-budget { margin-bottom: .4rem; }
  .ctx-budget-heading { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: .35rem; }
  .ctx-budget-bar { display: flex; height: 10px; border-radius: 5px; overflow: hidden; background: var(--vscode-input-background, #333); }
  .ctx-budget-fill { height: 100%; transition: width .2s ease; }
  .ctx-budget-files { background: var(--vscode-charts-blue, #4e94ce); }
  .ctx-budget-other { background: var(--vscode-panel-border, var(--vscode-editorWidget-border)); opacity: .5; }
  .ctx-budget-legend { display: flex; flex-wrap: wrap; gap: .6rem; margin-top: .3rem; font-size: .75rem; color: var(--vscode-descriptionForeground); }
  .ctx-budget-legend-item { display: inline-flex; align-items: center; gap: .25rem; }
  .ctx-swatch { width: .6rem; height: .6rem; border-radius: 2px; display: inline-block; }
  .ctx-swatch-files { background: var(--vscode-charts-blue, #4e94ce); }
  .ctx-swatch-other { background: var(--vscode-panel-border, var(--vscode-editorWidget-border)); opacity: .5; }
  .ctx-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
  .ctx-table th, .ctx-table td { text-align: left; padding: .25rem .4rem; border-bottom: 1px solid var(--vscode-panel-border, var(--vscode-editorWidget-border)); }
  .ctx-table thead th { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); font-weight: 600; }
  .ctx-table td.n, .ctx-table th.n { text-align: right; font-variant-numeric: tabular-nums; }
  .ctx-status-applied { color: var(--vscode-testing-iconPassed, #3a3); font-weight: 500; }
  .ctx-status-read { color: var(--vscode-charts-blue, #4e94ce); font-weight: 500; }
  .ctx-status-skipped { color: var(--vscode-descriptionForeground); }
  .ctx-category { font-size: .72rem; text-transform: uppercase; letter-spacing: .03em; padding: .08rem .3rem; border-radius: 3px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .ctx-warn { cursor: help; }
  .ctx-skip-reason { font-size: .75rem; }
  .ctx-file-link { color: var(--vscode-textLink-foreground, #4e94ce); text-decoration: none; }
  .ctx-file-link:hover { color: var(--vscode-textLink-activeForeground, #4e94ce); text-decoration: underline; }
  .ctx-ref-type { font-size: .72rem; font-family: var(--vscode-editor-font-family, monospace); }
  .ctx-missing-section p { font-size: .8rem; margin: .2rem 0 .4rem; }
  .ctx-accept-btn { background: none; border: 1px solid var(--vscode-button-secondaryBackground, #555); color: var(--vscode-button-secondaryForeground, #ccc); border-radius: 3px; padding: .1rem .4rem; cursor: pointer; font-size: .75rem; }
  .ctx-accept-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
  .ctx-accept-btn:disabled { opacity: .4; cursor: default; }
  .ctx-accept-source, .ctx-accept-file { cursor: pointer; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 2px; }
  .ctx-accept-source:hover, .ctx-accept-file:hover { color: var(--vscode-textLink-activeForeground, #4e94ce); }
  .ctx-oversized-section { display: flex; flex-direction: column; gap: .4rem; }
  .ctx-oversized-card { display: flex; align-items: flex-start; gap: .5rem; padding: .5rem .6rem; border-left: 3px solid var(--vscode-editorWarning-foreground, #c90); background: var(--vscode-inputValidation-warningBackground, transparent); border-radius: 0 4px 4px 0; }
  .ctx-oversized-icon { font-size: 1rem; }
  .ctx-oversized-info { display: flex; flex-direction: column; gap: .15rem; }
  .ctx-oversized-info .muted { font-size: .78rem; }
` + Array.from({ length: 101 }, (_, i) => `.ctx-w-${i}{width:${i}%}`).join('');

/**
 * The SINGLE in-page controller for the session-detail webview.
 *
 * It is set ONCE in the document shell (by `renderSessionDetailHtml` /
 * `renderCombinedSessionDetailHtml`); the panel never reassigns the webview HTML
 * afterwards. On a live or refresh re-render the panel posts an
 * `{ type: 'update', html }` message carrying the freshly-rendered BODY
 * (`renderSessionDetailContent` / `renderCombinedSessionDetailContent`). This
 * controller swaps that into `#live-root` and then RESTORES the volatile UI state
 * — which collapsibles are open (keyed by their `data-k`), the active tab, and the
 * scroll offset — so a data push never collapses sections, flips tabs, or jumps the
 * scroll. Because the document is never reloaded there is no flash, and
 * `acquireVsCodeApi()` is called exactly once (it may only be called once).
 *
 * The three interactions (token-trend legend filtering, tab switching, and
 * accept-missing actions) are re-runnable init functions, re-invoked after each
 * content swap so the freshly-injected nodes get their listeners.
 */
const WEBVIEW_CONTROLLER = `
(function() {
  var vscode = acquireVsCodeApi();
  var root = document.getElementById('live-root');
  var TOKEN_SERIES = ['input', 'cached', 'output'];
  var BAR_SERIES = ['loc', 'lod', 'nloc', 'nlod'];

  // ── Token-trend legend filtering ─────────────────────────────────────────────
  function initTrend() {
  (root || document).querySelectorAll('.tree-trend').forEach(function(container) {
    var svg = container.querySelector('.trend-svg');
    var legend = container.querySelector('.trend-legend');
    if (!svg || !legend) return;

    var pointsJson = container.getAttribute('data-trend-points');
    if (!pointsJson) return;
    var points = JSON.parse(pointsJson);
    if (points.length < 2) return;

    var activeFilters = new Set();
    var resetBtn = legend.querySelector('.trend-reset');

    // Chart geometry constants (must match the server render).
    var W = 600, H = 200;
    var m = { top: 10, right: 12, bottom: 26, left: 12 };
    var innerW = W - m.left - m.right;
    var innerH = H - m.top - m.bottom;
    var baseline = m.top + innerH;
    var n = points.length;

    function x(i) { return m.left + (innerW * i) / (n - 1); }
    function y(v, max) { return m.top + innerH - (innerH * v) / max; }
    function fmt(v) { return String(v).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ','); }
    function labelX(cx, text) {
      var halfW = (text.length * 6) / 2;
      var lo = m.left + halfW;
      var hi = W - m.right - halfW;
      return (lo > hi ? (m.left + (W - m.right)) / 2 : Math.min(hi, Math.max(lo, cx))).toFixed(1);
    }
    var LABEL_TOP = 10, DOT_CLUSTER_GAP = 11, DOT_LABEL_LINE = 11;

    // Rebuild the dots layer from scratch for the VISIBLE series at the rescaled
    // y positions — same clustering as the server render. Regenerating (instead of
    // nudging the server-rendered nodes) keeps markers, hover hit circles and value
    // labels consistent: hidden series leave no hoverable ghosts behind, and label
    // stacks re-cluster around the new dot positions.
    function renderDots(visibleTokens, tokenMax) {
      var layer = svg.querySelector('.trend-dots');
      if (!layer) return;
      var out = [];
      for (var i = 0; i < n; i++) {
        var cxv = x(i);
        var ds = visibleTokens.map(function(s) {
          return { key: s, cy: y(points[i][s], tokenMax), value: points[i][s] };
        }).sort(function(a, b) { return a.cy - b.cy; });
        var clusters = [];
        ds.forEach(function(d) {
          var last = clusters[clusters.length - 1];
          if (last && d.cy - last[last.length - 1].cy < DOT_CLUSTER_GAP) last.push(d);
          else clusters.push([d]);
        });
        clusters.forEach(function(cluster) {
          var labelBase = Math.max(cluster[0].cy - 7, LABEL_TOP + (cluster.length - 1) * DOT_LABEL_LINE);
          var markers = cluster.map(function(d) {
            return '<circle class="trend-dot trend-' + d.key + '" cx="' + cxv.toFixed(1) + '" cy="' + d.cy.toFixed(1) + '" r="2.2" />';
          }).join('');
          var labels = cluster.map(function(d, j) {
            var text = fmt(d.value);
            return '<text class="trend-dot-value trend-dot-val-' + d.key + '" x="' + labelX(cxv, text) + '" y="' + (labelBase - j * DOT_LABEL_LINE).toFixed(1) + '">' + text + '</text>';
          }).join('');
          var hits = cluster.map(function(d) {
            return '<circle class="trend-dot-hit" cx="' + cxv.toFixed(1) + '" cy="' + d.cy.toFixed(1) + '" r="5" />';
          }).join('');
          out.push('<g class="trend-dot-col">' + markers + labels + hits + '</g>');
        });
      }
      layer.innerHTML = out.join('');
    }

    function applyFilter() {
      var hasFilter = activeFilters.size > 0;

      // Update legend key styling.
      legend.querySelectorAll('.trend-key[data-series]').forEach(function(key) {
        var s = key.getAttribute('data-series');
        key.classList.toggle('trend-key-active', hasFilter && activeFilters.has(s));
        key.classList.toggle('trend-key-dimmed', hasFilter && !activeFilters.has(s));
      });

      // Show/hide reset button.
      if (resetBtn) resetBtn.classList.toggle('trend-reset-visible', hasFilter);

      // Determine which token series and bar series are visible.
      var visibleTokens = hasFilter ? TOKEN_SERIES.filter(function(s) { return activeFilters.has(s); }) : TOKEN_SERIES;
      var visibleBars = hasFilter ? BAR_SERIES.filter(function(s) { return activeFilters.has(s); }) : BAR_SERIES;

      // Rescale token lines and dots.
      var tokenMax = 1;
      if (visibleTokens.length > 0) {
        for (var i = 0; i < points.length; i++) {
          for (var t = 0; t < visibleTokens.length; t++) {
            var v = points[i][visibleTokens[t]];
            if (v > tokenMax) tokenMax = v;
          }
        }
      }

      // Update polylines.
      TOKEN_SERIES.forEach(function(s) {
        var line = svg.querySelector('.trend-line.trend-' + s);
        if (!line) return;
        var visible = !hasFilter || activeFilters.has(s);
        line.classList.toggle('trend-hidden', !visible);
        if (visible) {
          var pts = [];
          for (var i = 0; i < points.length; i++) {
            pts.push(x(i).toFixed(1) + ',' + y(points[i][s], tokenMax).toFixed(1));
          }
          line.setAttribute('points', pts.join(' '));
        }
      });

      // Rebuild the dots (markers + hover hits + value labels) for the visible
      // series only, re-clustered at the rescaled positions.
      renderDots(visibleTokens, tokenMax);

      // Rescale bars.
      var barsMax = 1;
      if (visibleBars.length > 0) {
        for (var i = 0; i < points.length; i++) {
          var addTotal = 0, remTotal = 0;
          if ((!hasFilter || activeFilters.has('loc'))) addTotal += points[i].loc;
          if ((!hasFilter || activeFilters.has('lod'))) addTotal += points[i].lod;
          if ((!hasFilter || activeFilters.has('nloc'))) remTotal += points[i].nloc;
          if ((!hasFilter || activeFilters.has('nlod'))) remTotal += points[i].nlod;
          var total = Math.max(addTotal, remTotal);
          if (total > barsMax) barsMax = total;
        }
      }

      // Update bars: hide filtered-out segments, restack and rescale the visible
      // ones, and keep the hover hit rect and on-hover value labels in step (the
      // hit rect must cover exactly the rendered stack so a hidden stapel leaves
      // no hoverable ghost, and labels of hidden segments must not appear).
      var barH = function(v) { return (innerH * v) / barsMax; };
      var cols = svg.querySelectorAll('.trend-col');
      // Bars are rendered as pairs of .trend-col per point (additions, removals).
      cols.forEach(function(col, colIdx) {
        var ptIdx = Math.floor(colIdx / 2);
        if (ptIdx >= points.length) return;
        var p = points[ptIdx];
        var isRemoval = colIdx % 2 === 1;
        var codeKey = isRemoval ? 'nloc' : 'loc';
        var docKey = isRemoval ? 'nlod' : 'lod';
        var showCode = !hasFilter || activeFilters.has(codeKey);
        var showDoc = !hasFilter || activeFilters.has(docKey);
        var codeVal = showCode ? p[codeKey] : 0;
        var total = codeVal + (showDoc ? p[docKey] : 0);
        col.classList.toggle('trend-col-hidden', !(showCode || showDoc));

        var codeBar = col.querySelector('.trend-bar-' + codeKey);
        if (codeBar) {
          codeBar.classList.toggle('trend-bar-hidden', !showCode);
          if (showCode) {
            codeBar.setAttribute('y', (baseline - barH(codeVal)).toFixed(1));
            codeBar.setAttribute('height', barH(codeVal).toFixed(1));
          }
        }
        var docBar = col.querySelector('.trend-bar-' + docKey);
        if (docBar) {
          docBar.classList.toggle('trend-bar-hidden', !showDoc);
          if (showDoc) {
            docBar.setAttribute('y', (baseline - barH(total)).toFixed(1));
            docBar.setAttribute('height', (barH(total) - barH(codeVal)).toFixed(1));
          }
        }
        // The hit rect tracks the visible stack; a zero-height rect has no
        // geometry, so a fully filtered-out stapel stops responding to hover.
        var hit = col.querySelector('.trend-col-hit');
        if (hit) {
          var hitH = barH(total);
          hit.setAttribute('y', (baseline - hitH).toFixed(1));
          hit.setAttribute('height', hitH.toFixed(1));
        }
        // Re-anchor the on-hover count labels above the visible stack top and
        // hide the label of any filtered-out segment.
        var label = col.querySelector('.trend-bar-value');
        if (label) {
          var docSpan = label.querySelector('.trend-val-' + docKey);
          var codeSpan = label.querySelector('.trend-val-' + codeKey);
          var docShown = !!docSpan && showDoc;
          var lower = Math.max(LABEL_TOP + (docShown ? 11 : 0), baseline - barH(total) - 4);
          if (docSpan) {
            if (showDoc) {
              docSpan.removeAttribute('display');
              docSpan.setAttribute('y', (lower - 11).toFixed(1));
            } else {
              docSpan.setAttribute('display', 'none');
            }
          }
          if (codeSpan) {
            if (showCode) {
              codeSpan.removeAttribute('display');
              codeSpan.setAttribute('y', lower.toFixed(1));
            } else {
              codeSpan.setAttribute('display', 'none');
            }
          }
        }
      });
    }

    // Legend key click handler.
    legend.querySelectorAll('.trend-key[data-series]').forEach(function(key) {
      key.addEventListener('click', function() {
        var s = key.getAttribute('data-series');
        if (activeFilters.has(s)) {
          activeFilters.delete(s);
        } else {
          activeFilters.add(s);
        }
        applyFilter();
      });
      key.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); key.click(); }
      });
    });

    // Reset button click handler.
    if (resetBtn) {
      resetBtn.addEventListener('click', function() {
        activeFilters.clear();
        applyFilter();
      });
      resetBtn.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); resetBtn.click(); }
      });
    }
  });
  }

  // ── Tab switching (Overview / Context Analysis) ──────────────────────────────
  function initTabs() {
  var buttons = (root || document).querySelectorAll('.tab-btn');
  var panels = (root || document).querySelectorAll('.tab-panel');
  buttons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      var target = btn.getAttribute('data-tab');
      buttons.forEach(function(b) { b.classList.remove('tab-btn-active'); });
      btn.classList.add('tab-btn-active');
      panels.forEach(function(p) {
        if (p.id === target) {
          p.classList.remove('tab-panel-hidden');
        } else {
          p.classList.add('tab-panel-hidden');
        }
      });
    });
  });
  }

  // ── Accept-missing actions (Context Analysis tab) ────────────────────────────
  function initAcceptMissing() {
  // "Accept file" buttons (checkmark in the last column)
  (root || document).querySelectorAll('.ctx-accept-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var file = btn.getAttribute('data-accept-file');
      if (file) {
        vscode.postMessage({ type: 'accept-missing-file', file: file });
        var row = btn.closest('tr');
        if (row) row.style.opacity = '0.4';
        btn.disabled = true;
      }
    });
  });

  // Clickable source file names
  (root || document).querySelectorAll('.ctx-accept-source').forEach(function(el) {
    el.addEventListener('click', function() {
      var source = el.getAttribute('data-source');
      if (source) {
        vscode.postMessage({ type: 'accept-missing-source', source: source });
        el.style.opacity = '0.4';
      }
    });
  });

  // Clickable missing file names
  (root || document).querySelectorAll('.ctx-accept-file').forEach(function(el) {
    el.addEventListener('click', function() {
      var file = el.getAttribute('data-file');
      if (file) {
        vscode.postMessage({ type: 'accept-missing-file', file: file });
        var row = el.closest('tr');
        if (row) row.style.opacity = '0.4';
      }
    });
  });
  }

  // ── Open-file links (Context Analysis tab) ───────────────────────────────────
  // File names carrying a data-path open the actual file in the editor via the
  // extension host (webviews cannot open documents themselves).
  function initCtxFileLinks() {
  (root || document).querySelectorAll('.ctx-file-link').forEach(function(el) {
    el.addEventListener('click', function(e) {
      e.preventDefault();
      var p = el.getAttribute('data-path');
      if (p) {
        vscode.postMessage({ type: 'open-context-file', path: p });
      }
    });
  });
  }

  function initAll() { initTrend(); initTabs(); initAcceptMissing(); initCtxFileLinks(); }

  // ── Volatile UI state, preserved across a content swap ───────────────────────
  // Snapshot which collapsibles are open (by their stable data-k) and the active
  // tab, then re-apply them after the swap so a data push leaves the view exactly
  // as the user left it. Unknown/new data-k keys keep their server-rendered default.
  function snapshotOpen() {
    var map = {};
    if (root) {
      root.querySelectorAll('details[data-k]').forEach(function(d) {
        map[d.getAttribute('data-k')] = d.open;
      });
    }
    return map;
  }
  function restoreOpen(map) {
    if (!root || !map) return;
    root.querySelectorAll('details[data-k]').forEach(function(d) {
      var k = d.getAttribute('data-k');
      if (Object.prototype.hasOwnProperty.call(map, k)) d.open = map[k];
    });
  }
  function activeTab() {
    var btn = root && root.querySelector('.tab-btn.tab-btn-active');
    return btn ? btn.getAttribute('data-tab') : null;
  }
  function restoreTab(id) {
    if (!root || !id) return;
    var btns = root.querySelectorAll('.tab-btn');
    var panels = root.querySelectorAll('.tab-panel');
    var found = false;
    btns.forEach(function(b) {
      var on = b.getAttribute('data-tab') === id;
      b.classList.toggle('tab-btn-active', on);
      if (on) found = true;
    });
    if (!found) return; // the saved tab no longer exists — keep the default
    panels.forEach(function(p) { p.classList.toggle('tab-panel-hidden', p.id !== id); });
  }

  // A live/refresh re-render arrives as new BODY markup. Swap it in, restore the
  // volatile UI state, and re-wire the interactions — all synchronously, so the
  // browser paints the restored result in a single frame (no flash, no reset).
  window.addEventListener('message', function(event) {
    var msg = event.data;
    if (!root || !msg || msg.type !== 'update' || typeof msg.html !== 'string') return;
    var openMap = snapshotOpen();
    var tab = activeTab();
    var sx = window.scrollX, sy = window.scrollY;
    root.innerHTML = msg.html;
    restoreOpen(openMap);
    restoreTab(tab);
    initAll();
    window.scrollTo(sx, sy);
  });

  initAll();
})();
`;
