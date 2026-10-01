# 4. Cost & efficiency analytics

## User story

As a developer paying for agents, I want cost shown per session and aggregated
per day, model, and repository, so that I can see what tasks and setups
actually cost and find cache-efficiency wins.

**Acceptance criteria**

- Session list rows show an estimated cost, on the basis appropriate to the
  source (estimated USD for Claude Code; AIU-derived USD for Copilot).
- The Dashboard gains: a total-cost tile for the window, a cost-per-day
  chart, and a cost-by-model table.
- The already-computed but hidden totals (LLM calls and tool calls) become
  Dashboard tiles too.
- List and Dashboard numbers match what the session detail view shows for the
  same sessions (same pricing code, not a reimplementation).
- Sessions with unknown models show "n/a" rather than a fabricated zero.
- No cost field is added to any sync path.

## Why this matters for research

Token counts are visible everywhere but cost (the number people actually
reason about) is computed in core in three modes and then dropped on the
floor: the desktop index has a `cost_micros` column that neither indexer
populates, so the list and Dashboard show nothing. Populating it turns "which
model/repo/practice is economical" into a question the Dashboard can answer,
and cost-per-day makes the impact of process changes visible.

## Agent spec

**Goal.** Populate the existing dead `costMicros` plumbing all the way through and
surface cost in the session list and Dashboard, plus the hidden LLM/tool-call
totals.

**Grounding: what already exists**

- Dead plumbing: `sessions.cost_micros` column and `SessionRow.costMicros`
  ("Precomputed so list rows never recompute pricing") exist in
  `src/desktop/agent-observability-desktop/src/datahost/indexer/indexDb.ts`
  and `src/desktop/agent-observability-desktop/src/shared/rpc.ts`, but neither
  indexer writes it; see the row construction in
  `indexer/claudeIndexer.ts` (around lines 218–241) and
  `indexer/copilotIndexer.ts` (around lines 284–304).
- Pricing in core, already used by the detail view:
  - Claude: `claudeCostMicros(model, usage)` in
    `src/core/agent-observability-core/src/claude/pricing.ts`: integer
    micro-USD, per-family rates, cache read/write multipliers, unknown model
    yields 0 with `isKnownModel` to distinguish "free" from "unknown".
  - Copilot: billed AIU from the `copilot_chat.copilot_usage_nano_aiu` span
    attribute summed over chat spans; `aiuToUsd` in
    `src/core/agent-observability-core/src/telemetry/pricing.ts`
    (fixed rate 0.01 USD per AIU).
- Overview aggregation: `overview()` in `indexDb.ts` (around lines 398–472)
  already computes `totals.llmCalls` and `totals.toolCalls` and returns them
  in `OverviewData`, but the Dashboard just never renders them. Charts are
  hand-rolled SVG in
  `src/desktop/agent-observability-desktop/src/renderer/src/views/overview/charts.tsx`;
  tiles and layout in `views/overview/OverviewView.tsx`.
- Consistency requirement: the detail view computes per-model cost via core
  (`SessionModelUsage.costUsdMicros` etc.), so the indexers must sum the same
  way so list equals detail.

**Implementation outline**

1. **Indexers.** During hydration, compute the session's cost:
   - Claude: sum `claudeCostMicros` over the per-turn usage the indexer
     already parses (mirror how the detail path derives `SessionModelUsage`
     so numbers match; unknown models contribute nothing and mark the row
     n/a).
   - Copilot: sum AIU nano over the session's chat spans (one aggregate
     query, same style as the existing session query) and convert with
     `aiuToUsd` to micro-USD.
   Store micro-USD in `cost_micros`; the display basis is implied by
   `source`. Distinguish "0 because unknown model" (store NULL) from a true
   zero.
2. **Rebuild.** The column exists, but existing rows hold NULL. Bump
   `SCHEMA_VERSION` in `indexDb.ts` to force the drop-and-rebuild so history
   is populated (cheap by design; that is the migration strategy).
3. **List.** Append cost to the row meta line in
   `views/sessions/SessionsView.tsx` / `format.ts` ("N steps · X tokens ·
   duration · $Y.ZZ"), rendering nothing when NULL.
4. **Dashboard.** Extend the `overview()` SQL with cost sums (total, per day,
   per model; `model` is a column on `sessions`), extend `OverviewData` in
   `shared/rpc.ts`, then add: a Cost tile, LLM calls and Tool calls tiles,
   a cost-per-day chart (reuse the existing stacked-bar SVG component), and a
   compact cost-by-model table.
5. **Changelog + version.** Minor bump; entry under `### Added` ("See what
   your sessions cost: in the list, and per day and per model on the
   Dashboard").

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these). Cost
never leaves the machine: the aggregate schema has no cost field and must not
gain one.

**Out of scope.** A pricing-settings UI, credits display for the
Copilot-cloud source (`creditsNano`/`creditUnit`, whose scale is still
unconfirmed), budget alerts, currency settings.

**Verification**

- Unit tests: each indexer produces the expected `cost_micros` for fixture
  sessions (Claude known model, Claude unknown model yields NULL, Copilot
  AIU); overview SQL sums per day/model correctly.
- `npm run typecheck -w agent-observability-desktop`,
  `npm test -w agent-observability-desktop`.
- Manual: pick one session, compare the list row's cost with the detail
  view's cost card: they must match; Dashboard tiles and charts populate;
  an unpriced model shows n/a.
