# 7. Tool usage analytics view

## User story

As a developer studying what agents actually do, I want per-tool statistics —
call volume, failure rate, and duration — sliced by source, model, and
repository, so that I can find friction tools and failure outliers and fix
their causes (permissions, prompts, tool design).

**Acceptance criteria**

- A new "Tools" analysis (its own sidebar view, or a Dashboard section) shows
  a sortable table per tool: calls, failures, failure %, typical and worst
  durations, last used.
- I can slice by source and repository; the time window follows the Dashboard
  selector (proposal 5) or has its own.
- Clicking a tool shows the recent sessions where it failed most, each
  opening the session detail.
- Everything is computed locally from the index; nothing is synced.

## Why this matters for research

Tool calls are what agents *do* — and per-call data (name, duration,
success) is parsed by every source today and then collapsed into a single
per-session count. A failure-rate outlier ("this MCP tool fails 40% of the
time") is invisible until someone stumbles on it in a transcript, yet it is
exactly the kind of process problem — a broken permission, a misdocumented
tool, a flaky server — that is cheap to fix once seen.

## Agent spec

**Goal.** Persist per-tool aggregates at index time and add a Tools view over
them.

**Grounding — what already exists**

- Per-tool-call data is already parsed in every source and discarded after
  counting:
  - Copilot: tool spans carry `tool_name`, start/end times, and
    `status_code` (success = `status_code !== 2`) — the indexer
    (`src/desktop/agent-observability-desktop/src/datahost/indexer/copilotIndexer.ts`)
    aggregates the session in SQL; a per-tool GROUP BY over the same archive
    is one more query. See span classification patterns and the session-key
    expression in `src/core/agent-observability-core/src/telemetry/database.ts`
    and `src/core/agent-observability-core/src/telemetry/sessionFilter.ts`.
  - Claude: the mapper produces per-tool entries (`ExtractedTool` with
    `{name, durationMs, success}`) in
    `src/core/agent-observability-core/src/claude/mapper.ts` — the desktop's
    `indexer/claudeIndexer.ts` already runs this parse during hydration.
- Histogram precedent for durations: the fixed-bounds mergeable latency
  histogram (`LATENCY_BOUNDS_MS = [100, 250, 500, 1000, 2000, 5000, 10000,
  30000]`) in `src/core/agent-observability-core/src/aggregate/models.ts` —
  reuse the same shape locally so percentiles are approximated the same way
  the dashboard does.
- Index schema changes are drop-and-rebuild via the `SCHEMA_VERSION` bump in
  `src/datahost/indexer/indexDb.ts` — no migration code needed.
- Cross-view navigation to a pre-filtered/opened session: the intent built in
  proposal 5 (`03-context-hotspots.md` reuses it too). If this proposal is
  built first, add a minimal "open session" callback at the `App.tsx` level.

**Implementation outline**

1. **Schema.** New table keyed per `(source, session_id, tool_name)` holding
   `calls`, `failures`, `duration_ms_sum`, `duration_ms_max`, and a small
   fixed-bounds duration histogram (9 integer columns or one packed JSON
   column — prefer columns for SQL aggregation). Per-(session, tool)
   aggregates keep volume bounded (rows = sessions × distinct tools) while
   still allowing repository/date slicing via a join to `sessions`. Bump
   `SCHEMA_VERSION`.
2. **Indexers.** Emit the per-tool rows in the same hydration pass each
   indexer already performs: Claude from the extracted tools; Copilot from
   one additional GROUP BY query per session (or one for the whole refresh,
   grouped by session and tool).
3. **RPC.** `tools.get(params: { source?, repository?, startedAfterMs?,
   startedBeforeMs? })` returning ranked per-tool rows (merged histograms,
   summed counts) plus, per tool, the top few sessions by failures for the
   drill-down.
4. **Renderer.** New `views/tools/` React view: sortable table, failure-rate
   inline bars (hand-rolled SVG, consistent with `views/overview/charts.tsx`),
   slice controls, expandable per-tool session list that opens session
   detail. Add the rail item (or place it as a Dashboard section if a new
   rail item feels heavy — implementer's choice, note it in the changelog).
5. **Changelog + version.** Minor bump; `### Added` entry ("See which tools
   your agents call, how often they fail, and how long they take").

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these). Tool
*names* are safe locally, but this feature must not feed any sync path — the
cloud contract's allowlist/`custom` collapsing
(`src/core/agent-observability-core/src/aggregate/builtinTools.ts`) is not to
be relaxed as part of this work.

**Out of scope.** Analyzing tool arguments or results content, MCP-server
attribution beyond the tool name, alerting on failure-rate thresholds,
cross-machine comparison.

**Verification**

- Unit tests: indexers produce expected per-tool rows for fixture sessions
  (mixed success/failure, durations spanning histogram bounds); `tools.get`
  merges histograms and filters by repository/date correctly.
- `npm run typecheck -w agent-observability-desktop`,
  `npm test -w agent-observability-desktop`.
- Manual: on a real corpus, the Tools view ranks plausibly (file edit/read
  tools near the top), a known-flaky tool shows a non-zero failure rate, and
  drill-down opens the right sessions. Rebuild happens automatically on
  first launch after the schema bump (watch the index status bar).
