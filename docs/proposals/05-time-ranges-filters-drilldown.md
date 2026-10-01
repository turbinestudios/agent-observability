# 5. Dashboard time ranges, filters & drill-down

## User story

As a developer studying how agent behavior changes over time, I want to pick
the Dashboard's time window, click any chart segment or repository to see the
sessions behind it, and filter the session list by repository and date, so
that I can slice cohorts and compare before/after a process change.

**Acceptance criteria**

- The Dashboard has a window selector (7 / 30 / 90 days), and every tile and
  chart respects it (custom range is a nice-to-have, not required).
- Clicking a repository bar, a by-source row, or a day column on the
  Dashboard navigates to the Sessions view pre-filtered accordingly, with
  visible, clearable filter chips.
- The Sessions view gains a repository filter and a date-range filter that
  combine with the existing source filter and search.
- The list no longer silently stops at 300 sessions: a "Load more" control
  (or automatic paging on scroll) reaches the rest.

## Why this matters for research

Every research question is a slice: "this repo, last two weeks", "the week
before vs the week after we rewrote CLAUDE.md". Today the Dashboard is a fixed
30-day window with no interactions, the repository dimension is fetched and
thrown away, and sessions past the 300th are unreachable except via search.
Most of the backend for this proposal already exists: the repository filter
is implemented in SQL and never used. The cross-view navigation built here is
also the landing path proposals 3, 7, and 8 reuse.

## Agent spec

**Goal.** Parameterize the overview window, add repository/date filters to
the session list, make Dashboard charts clickable into a pre-filtered
Sessions view, and add paging past the first 300 rows.

**Grounding: what already exists**

- Hard-coded window: `OVERVIEW_WINDOW_DAYS = 30` at
  `src/desktop/agent-observability-desktop/src/datahost/index.ts:68`, applied
  at `db.overview(OVERVIEW_WINDOW_DAYS, …)` (line ~367); the aggregate SQL is
  `overview()` in `src/datahost/indexer/indexDb.ts` (lines ~398–472).
- Repository filter already implemented in SQL:
  `ListSessionsParams.repository` is honoured at `indexDb.ts:569-571`
  (`repository = ?`), and the `sessions.groups()` RPC already returns
  `{source, repository, count, newestMs}` per group, but the UI currently
  collapses it to per-source totals in
  `src/renderer/src/views/sessions/SourceFilter.tsx` and discards
  `repository`.
- Paging support unused: `useSessions.ts` sets `PAGE_SIZE = 300` and never
  uses the `offset` param that `sessions.list` already accepts
  (`clampLimit` allows up to 2000).
- Charts are hand-rolled SVG (`views/overview/charts.tsx`), so adding onClick
  handlers per bar/row is straightforward; hover tooltips already exist.
- Cross-view state: `App.tsx` holds a plain `useState<ViewId>`; the Sessions
  view is permanently mounted (hidden, not unmounted), so external filter
  changes must flow in as props/context rather than mount-time state.

**Implementation outline**

1. **Overview window.** Change the RPC to `overview.get(params: { days })`
   (validate to 7/30/90 in the datahost; keep 30 the default), thread `days`
   through `overview()`. Renderer: a segmented control in `OverviewView.tsx`;
   persist the last choice in `localStorage` alongside the theme key.
2. **Sessions filters.** Add `startedAfterMs` / `startedBeforeMs` to
   `ListSessionsParams` in `shared/rpc.ts` with matching WHERE clauses in
   `indexDb.ts` (confirm `started_at_ms` is indexed; add an index in the DDL
   if not, and bump `SCHEMA_VERSION` if the DDL changes). Surface a repository
   dropdown (populated from `sessions.groups()`, which already has the data)
   and a date-range control; render active filters as clearable chips next to
   the source chips.
3. **Drill-down.** Introduce a small navigation intent at the `App.tsx`
   level, `openSessions(filters: {source?, repository?, startedAfterMs?,
   startedBeforeMs?})`, passed to both views. Dashboard charts call it from
   onClick on repository bars, by-source rows, and day columns (day click
   sets a one-day range).
4. **Paging.** Use the existing `offset` param: keep the first page at 300,
   append on "Load more" (the list is virtualized with
   `@tanstack/react-virtual`, so total row count is not a rendering concern).
   Preserve the live-merge behavior (`sessions.upserted`) across pages.
5. **Changelog + version.** Minor bump; entries under `### Added` (window
   selector, filters, click-through), written for the user, e.g. "Click a
   repository on the Dashboard to see its sessions."

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these). Keep all
filtering in SQL in the datahost, with no renderer-side filtering of large lists.

**Out of scope.** Period-over-period overlay charts (a natural follow-up once
windows are parameterized), saved filter presets (proposal 6's tags cover the
durable-grouping need), calendar-style custom range picker if it drags (two
date inputs are fine).

**Verification**

- Unit tests: `listSessions` respects the new date params combined with
  source/repository/query; `overview(days)` honours 7/30/90.
- `npm run typecheck -w agent-observability-desktop`,
  `npm test -w agent-observability-desktop`.
- Manual: switch the Dashboard to 7 days: tiles shrink accordingly. Click a
  repository bar: the Sessions view opens filtered with a visible chip.
  Clear the chip: the full list returns. "Load more" reaches sessions past
  the 300th.
