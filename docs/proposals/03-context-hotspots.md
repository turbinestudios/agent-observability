# 3. Context Hotspots view (replace the placeholder)

## User story

As someone maintaining CLAUDE.md, instruction files, and skills, I want a
ranked view of which context files my agents actually load, skip, or overload,
so that I can tune those files based on evidence instead of guesswork.

**Acceptance criteria**

- The Context Hotspots item in the sidebar shows a real view instead of the
  "Coming in a later milestone" placeholder.
- Context files are ranked busiest-first with: category (instruction / skill /
  agent / hook / prompt), applied and skipped counts, estimated tokens (max),
  error and deviation co-occurrence, and last seen.
- Files over the 2,000-token guideline are visibly flagged as oversized.
- Expanding a file lists the contributing sessions; clicking one opens that
  session's detail (ideally on its Context Analysis tab).
- Everything is computed locally from indexed sessions; a repository filter
  narrows the ranking.

## Why this matters for process improvement

Instruction files are the main lever teams have over agent behavior, and today
the only way to see whether a file is actually pulled into context is opening
sessions one by one. A ranked hotspots view answers directly: which files are
loaded constantly (keep them tight), which are skipped (fix or delete), which
are oversized (split), and which co-occur with errors and deviations (review
first). The sidebar already promises exactly this view.

## Agent spec

**Goal.** Replace the `hotspots` placeholder with a React view backed by a new
datahost service that aggregates core's per-session context analyses into a
ranked context-file table.

**Grounding: what already exists**

- Placeholder:
  `src/desktop/agent-observability-desktop/src/renderer/src/views/PlaceholderView.tsx`,
  wired to the `hotspots` entry in
  `src/desktop/agent-observability-desktop/src/renderer/src/components/ActivityRail.tsx`
  and `App.tsx`.
- Core hotspot logic:
  `src/core/agent-observability-core/src/context/contextHotspotsProvider.ts`
  (`CopilotContextHotspotsProvider`, `HotspotTelemetry` interface,
  `HOTSPOT_SESSION_LIMIT = 150`) and
  `src/core/agent-observability-core/src/aggregate/contextHotspotsIndex.ts`
  (`ContextHotspot`, `ContextHotspotSession`: applied counts, est tokens,
  hadError/hadDeviation per session).
- Per-session analyses come from core's context analyzer
  (`src/core/agent-observability-core/src/context/contextAnalyzer.ts`) and the
  Claude variant
  (`src/core/agent-observability-core/src/claude/claudeContextAnalyzer.ts`).
  The desktop's `DetailRenderer`
  (`src/desktop/agent-observability-desktop/src/datahost/detail/detailRenderer.ts`)
  already invokes them for the Context Analysis tab and memoizes per session.
- Reference UI (tree flavor): the extension's
  `src/extension/agent-observability-vscode/src/views/contextHotspotsView.ts`,
  which ranks files busiest-first and expands each to its contributing sessions.
- The oversized threshold is `OVERSIZED_THRESHOLD_TOKENS = 2000` in
  `src/core/agent-observability-core/src/context/sizeEstimator.ts`.

**Implementation outline**

1. **RPC.** Add `hotspots.get(params?: { repository?: string })` to
   `src/desktop/agent-observability-desktop/src/shared/rpc.ts`, returning
   typed rows (not HTML; build this view in React like Overview so rows can
   expand and navigate). Implement in the datahost dispatch switch
   (`src/datahost/index.ts`).
2. **Datahost service.** Walk the most recent N indexed sessions per source
   (start with core's `HOTSPOT_SESSION_LIMIT`), obtain each session's
   `SessionContextAnalysis` (reusing `DetailRenderer`'s memoized parses when
   present) and feed observations into `contextHotspotsIndex`. This is
   parse-heavy: run it off the request path (kick off after hydration
   completes, cache the result keyed on the set of `indexedAtMs` values, and
   let `hotspots.get` return the cache plus a `building` flag the UI can show
   as a progress note). Either implement `HotspotTelemetry` over the desktop's
   source registry or build hotspots from per-session analyses directly via
   `contextHotspotsIndex`. Pick whichever needs less new core surface.
3. **Renderer.** New `views/hotspots/` view: ranked table (file, category,
   applied, skipped, est tokens with an oversized badge, errors co-occur,
   deviations co-occur, last seen), a repository dropdown, and expandable
   per-file session rows. Clicking a session switches to the Sessions view
   with that session opened; add a small cross-view "open session" intent at
   the `App.tsx` level (the Sessions view is permanently mounted, so the
   intent can be passed down as a prop/callback).
4. **Changelog + version.** Minor bump; entry under `### Added` in user terms
   ("See which instruction and customization files your agents actually
   load…"; the placeholder's own promise is a good starting point).

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these). This view
is strictly local; it must not touch the cloud context-insights sync path
(`src/core/agent-observability-core/src/aggregate/contextInsights*.ts`).

**Out of scope.** The cloud dashboard's weighted hotspot score (the local view
shows raw signals ranked by applied count; the score formula in
`src/dashboard/AgentObservability.Dashboard/Services/Analytics/ContextHotspotAnalyticsService.cs`
can be ported later if wanted), sprint-length selectors, editing files from
the app.

**Verification**

- Unit tests for the datahost aggregation: fixture sessions with known
  context analyses produce expected ranked rows, and the cache invalidates
  when a session's `indexedAtMs` changes.
- `npm run typecheck -w agent-observability-desktop`,
  `npm test -w agent-observability-desktop`.
- Manual: open Context Hotspots on a real corpus: ranking appears (with a
  progress note while building), oversized files are flagged, expanding a
  file lists sessions, and clicking one lands on that session's detail.
