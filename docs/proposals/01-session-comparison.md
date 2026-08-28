# 1. Session comparison view (A/B runs)

## User story

As a developer researching agent behavior, I want to select two or more
sessions in the list and open them as **one combined view**, so that I can
compare how different prompts, models, or agent setups handled the same task.

**Acceptance criteria**

- I can select multiple sessions in the session list (checkbox on hover plus
  Ctrl/Cmd-click), and a compare bar appears offering "Compare N sessions".
- The combined view shows merged totals and a token trend in which each
  session's span is delimited and labeled, plus one collapsible section per
  session — so I can see at a glance which run burned more tokens, took more
  turns, or wrote more code.
- Sessions from different sources (Claude Code + Copilot) can be combined;
  when their cost bases differ the view uses a single cost basis and says so.
- Selection survives search and filtering; opening a single session the normal
  way is unchanged; a Close control (or Escape) returns to the single-session
  flow.
- Nothing about this feature touches the network.

## Why this matters for research

Comparing runs is the core loop of agent research: same task, two prompts;
same prompt, two models; before and after an instruction-file change. Today
the only way is opening two sessions one after another and remembering
numbers. Core already contains a complete, tested combined-view renderer —
this proposal is almost entirely wiring.

## Agent spec

**Goal.** Add multi-select to the desktop session list and a combined detail
view rendered by core's existing combined-session renderer.

**Grounding — what already exists**

- Core renderer, fully built and tested: `renderCombinedSessionDetailHtml`
  (line ~204) and `renderCombinedSessionDetailContent` (line ~239) in
  `src/core/agent-observability-core/src/views/sessionDetailHtml.ts`; tests in
  `src/core/agent-observability-core/src/views/combinedSessionDetailHtml.test.ts`.
  The combined model (`CombinedSummary`, `CombinedSessionDetail`) lives in
  `src/core/agent-observability-core/src/telemetry/combinedSessionDetail.ts`.
- Reference implementation of the whole flow (multi-select to combined panel,
  including the cross-source single-cost-basis narrowing and its warning):
  `src/extension/agent-observability-vscode/src/views/sessionDetailPanel.ts`
  (`SessionDetailPanelManager`). Follow its usage of the combined builder.
- Desktop detail pipeline to reuse unchanged: the datahost renders a full HTML
  document
  (`src/desktop/agent-observability-desktop/src/datahost/detail/detailRenderer.ts`,
  themed by `detail/theme.ts` via `detailHeadHtml`), the renderer stashes it
  through `window.desktop.stashDetail` and shows it in a sandboxed iframe at
  an `ao-detail://` URL
  (`src/desktop/agent-observability-desktop/src/renderer/src/views/sessions/SessionDetail.tsx`).
- RPC contract: `src/desktop/agent-observability-desktop/src/shared/rpc.ts`;
  dispatch switch:
  `src/desktop/agent-observability-desktop/src/datahost/index.ts`.

**Implementation outline**

1. **RPC.** Add `sessions.combinedDetail(keys: {source, sessionId}[], theme)`
   returning a full HTML document string. In the datahost, load each
   session's `SessionDetail` through the existing per-source detail path
   (reuse `DetailRenderer`'s memoized parses), build the combined view with
   core's combined-session builder exactly as the extension's
   `sessionDetailPanel.ts` does, and render with
   `renderCombinedSessionDetailHtml` plus `detailHeadHtml`.
2. **Memoization.** Cache keyed on the sorted set of
   `(source, sessionId, indexedAtMs)` tuples — same pattern as
   `DetailRenderer`.
3. **Renderer.** Multi-select state in
   `src/desktop/agent-observability-desktop/src/renderer/src/views/sessions/SessionsView.tsx`:
   a checkbox that appears on row hover, Ctrl/Cmd-click toggling, and a
   compare bar (count, "Compare", "Clear") when at least 2 are selected. On
   compare, fetch the document, stash it, and point the existing detail
   iframe at it.
4. **Cost basis.** Apply the extension's rule: a combined view uses a single
   cost basis; surface its note in the UI when sources are mixed.
5. **Changelog + version.** Minor bump; entry under `### Added` describing
   selecting sessions and comparing them.

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these). No index
schema change is needed.

**Out of scope.** Repository rollup views (`renderRepositoryDetailHtml` — see
the README's future candidates), transcript content diffing, persisting
selections across restarts.

**Verification**

- `npm run typecheck -w agent-observability-desktop` and
  `npm test -w agent-observability-desktop` pass; add unit tests for the new
  RPC handler (combined totals equal the sum of the parts) and the selection
  reducer.
- Manual (`npm run dev -w agent-observability-desktop`): select two Claude
  sessions — combined totals equal the sum of the two details and the token
  trend shows two labeled spans; select Claude + Copilot — the cost-basis
  note appears; Escape returns to the normal flow.
