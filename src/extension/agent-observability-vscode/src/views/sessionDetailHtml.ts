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
import { aiuToUsd } from '../telemetry/pricing';
import { escapeHtml } from './escapeHtml';

/** One combined session, paired with the data the panel resolves per session. */
export interface CombinedSessionSection {
  detail: SessionDetail;
  /** Workflow deviations detected for THIS session (rendered in its section). */
  deviations: readonly WorkflowDeviation[];
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
  ${renderTreeSummary(detail.treeStats, detail.treeModelTurns)}
  ${renderMainAgentUsage(detail.agentUsage)}
  ${renderSubAgentUsage(detail.agentUsage)}
  ${renderDeviations(deviations)}
  ${renderTurns(detail.turns)}
</body>
</html>`;
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
export function renderCombinedSessionDetailHtml(view: CombinedSessionView, nonce: string): string {
  const { combined, sections } = view;
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    "img-src 'none'",
    "font-src 'none'",
    "script-src 'none'",
  ].join('; ');

  const sectionsHtml = sections
    .map((section, index) => renderSessionSection(section, index === 0))
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

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Combined sessions (${num(combined.summary.sessionCount)})</title>
  <style nonce="${nonce}">${STYLE}</style>
</head>
<body>
  ${renderCombinedHeader(combined.summary)}
  ${renderTreeSummary(combined.treeStats, mergedModelTurns, trendSessions)}
  ${renderMainAgentUsage(combined.agentUsage)}
  ${renderSubAgentUsage(combined.agentUsage)}
  <section class="panel">
    <div class="panel-heading"><h2>Sessions</h2><span>${num(sections.length)} session(s)</span></div>
    <div class="turns">${sectionsHtml}</div>
  </section>
</body>
</html>`;
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

/**
 * One session's section in the combined view: a `<details>` (open when `open`)
 * whose summary is the session's id/title and headline counts, and whose body is
 * a compact meta line, the session's deviations, and its turns. Reuses the same
 * deviation/turn section helpers as the single-session renderer.
 */
function renderSessionSection(section: CombinedSessionSection, open: boolean): string {
  const { detail, deviations } = section;
  const s = detail.summary;
  const id = escapeHtml(shortId(s.sessionId));
  const titleLabel =
    s.title !== undefined && s.title.length > 0
      ? `<span class="turn-label">${escapeHtml(truncate(s.title, 60))}</span>`
      : `<span class="turn-label">Session ${id}</span>`;
  // This session's cost = its whole-tree AIU at the fixed rate (no estimate).
  const costLabel =
    detail.treeStats.aiuNano > 0
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

  return `<details class="turn-request session-section"${open ? ' open' : ''}>
    <summary>${summaryRow}</summary>
    <div class="section-body">
      ${meta}
      ${renderDeviations(deviations)}
      ${renderTurns(detail.turns)}
    </div>
  </details>`;
}

/**
 * Sanitized session header: just the session id and WHEN it ran (start / end /
 * duration). The richer per-thread breakdown (models, counts, tokens, cost) lives
 * in the "By model" table and "Agent run totals" card below, so the header stays
 * a thin temporal overview.
 */
function renderHeader(detail: SessionDetail): string {
  const s = detail.summary;
  return `<header class="header">
    <p class="eyebrow">Session</p>
    <h1>${escapeHtml(shortId(s.sessionId))}</h1>
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
): string {
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
    { acr: 'AIU', label: 'Copilot Usage (AIU)', value: formatAiu(stats.aiuNano) },
    { acr: 'LOC', label: 'Lines of Code (added)', value: formatInt(stats.linesOfCode) },
    { acr: 'LOD', label: 'Lines of Documentation (added)', value: formatInt(stats.linesOfDoc) },
    { acr: 'nLOC', label: 'Lines of Code (removed)', value: formatInt(stats.linesOfCodeRemoved) },
    { acr: 'nLOD', label: 'Lines of Documentation (removed)', value: formatInt(stats.linesOfDocRemoved) },
  ];
  const rows = totals
    .map(
      (t) =>
        `<div class="tt-row"><dt title="${escapeHtml(t.label)}">${escapeHtml(t.acr)}</dt><dd>${t.value}</dd></div>`,
    )
    .join('\n');

  return `<section class="panel">
    <div class="panel-heading"><h2>Agent run totals</h2><span>incl. spawned sub-agents</span></div>
    <div class="tree-row">
      ${renderTokenTrend(modelTurns, trendSessions)}
      <dl class="tree-totals">
        ${rows}
      </dl>
    </div>
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
 * by `style-src 'nonce-…'`), no script. All values are numeric and the only text
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
  const legend =
    series
      .map(
        (s) =>
          `<span class="trend-key"><span class="trend-swatch trend-${s.key}"></span>${s.label}</span>`,
      )
      .join('') +
    barKeys
      .map(
        (s) =>
          `<span class="trend-key"><span class="trend-swatch trend-${s.key}"></span>${s.label}</span>`,
      )
      .join('') +
    // When bucketed, make the grouping explicit so a point reading "Turns 1–5" is
    // understood as a sum, not a single turn.
    (bucketSize > 1
      ? `<span class="trend-key trend-group-note">grouped by ${GROUP_SIZE} model turns</span>`
      : '');

  return `<div class="tree-trend">
    <svg class="trend-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Whole-tree token usage and lines written per model turn">
      ${hGrid.join('\n')}
      ${xGrid.join('\n')}
      ${dividers}
      ${axis}
      ${lines}
      ${dots}
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
function renderMainAgentUsage(usage: readonly SessionAgentUsage[]): string {
  return renderAgentUsage(
    usage.filter((u) => u.kind === 'main'),
    {
      heading: 'Main agent',
      countNoun: 'model',
      footerLabel: 'Total',
      callsTitle: 'Main-thread model turns (chat spans) for this model',
    },
  );
}

/**
 * "Spawned sub-agents" breakdown: one row per (agent, model) the main agent
 * launched via a `runSubagent` tool call (the `agentUsage` rows of kind
 * `subagent`). Rendered only when the session spawned at least one sub-agent. Each
 * row shows the sub-agent's real tokens AND AIU, read from its own `chat` spans.
 */
function renderSubAgentUsage(usage: readonly SessionAgentUsage[]): string {
  return renderAgentUsage(
    usage.filter((u) => u.kind === 'subagent'),
    {
      heading: 'Spawned sub-agents',
      countNoun: 'invocation group',
      footerLabel: 'Sub-agent total',
      callsTitle: 'Model turns (chat spans) for this sub-agent',
      note:
        'Sub-agents launched by this session via <code>runSubagent</code>, with the real tokens and AIU recorded on their own <code>chat</code> spans. The whole-run rollup is in the "Agent run totals" card above.',
    },
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
      linesOfCode: 0,
      linesOfDoc: 0,
      linesOfCodeRemoved: 0,
      linesOfDocRemoved: 0,
    },
  );

  const bodyRows = rows
    .map(
      (u) => `<tr>
        <td>${escapeHtml(u.agentName)}</td>
        <td class="model">${escapeHtml(u.model)}</td>
        <td class="n">${num(u.llmCalls)}</td>
        <td class="n">${num(u.inputTokens)}</td>
        <td class="n">${num(u.outputTokens)}</td>
        <td class="n">${num(u.cachedTokens)}</td>
        <td class="n">${formatAiu(u.aiuNano)}</td>
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
          <th class="n" title="AIU (Copilot premium-request units) recorded on these spans — the actual billed usage — with the derived cost at $0.01/AIU">AIU</th>
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
          <td class="n">${formatAiu(totals.aiuNano)}</td>
          <td class="n">${num(totals.linesOfCode)}</td>
          <td class="n">${num(totals.linesOfDoc)}</td>
          <td class="n">${num(totals.linesOfCodeRemoved)}</td>
          <td class="n">${num(totals.linesOfDocRemoved)}</td>
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
  .tree-row { display: flex; gap: 1rem; align-items: stretch; margin: .5rem 0 0; }
  .tree-trend { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: .4rem; }
  .tree-trend-empty { align-items: center; justify-content: center; border: 1px dashed var(--vscode-panel-border, var(--vscode-editorWidget-border)); border-radius: 5px; padding: 1rem; }
  .trend-svg { width: 100%; height: auto; display: block; }
  .trend-line { fill: none; stroke-width: 1.5px; }
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
  .trend-bar { opacity: .55; }
  .trend-bar.trend-bar-loc { fill: var(--vscode-charts-purple, #b180d7); }
  .trend-bar.trend-bar-lod { fill: var(--vscode-charts-orange, #d18616); }
  .trend-bar.trend-bar-nloc { fill: var(--vscode-charts-red, #be1100); }
  .trend-bar.trend-bar-nlod { fill: #e07b86; }
  .trend-col { cursor: crosshair; }
  .trend-col-hit { fill: transparent; pointer-events: all; }
  .trend-col:hover .trend-col-hit { fill: var(--vscode-list-hoverBackground, var(--vscode-foreground)); opacity: .12; }
  .trend-col:hover .trend-bar { opacity: 1; }
  .trend-bar-value { opacity: 0; text-anchor: middle; font-family: var(--vscode-font-family); font-size: 10px; font-weight: 600; paint-order: stroke; stroke: var(--vscode-editor-background, var(--vscode-editorWidget-background)); stroke-width: 3px; stroke-linejoin: round; }
  .trend-col:hover .trend-bar-value { opacity: 1; }
  .trend-val-loc { fill: var(--vscode-charts-purple, #b180d7); }
  .trend-val-lod { fill: var(--vscode-charts-orange, #d18616); }
  .trend-val-nloc { fill: var(--vscode-charts-red, #be1100); }
  .trend-val-nlod { fill: #d6409a; }
  .trend-legend { display: flex; gap: .9rem; font-size: .75rem; color: var(--vscode-descriptionForeground); }
  .trend-key { display: inline-flex; align-items: center; gap: .3rem; }
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
`;
