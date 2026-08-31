# Desktop App — Research-Functionality Proposals

Ten proposals for new functionality in the **Agent Observability desktop app**
(`src/desktop/agent-observability-desktop`), aimed at two goals: better
**research into how agents behaved**, and better **feedback into our own
processes** (prompts, instruction files, workflows, cost).

Each proposal is one file: a human-readable **user story** with acceptance
criteria, followed by a **self-contained agent spec** that can be handed to an
implementation agent as-is ("implement `docs/proposals/NN-slug.md`"). Specs
embed the concrete file paths and existing assets they build on, so no
re-exploration is needed.

Proposals 1–4 are mostly wiring capability that **already exists in core** but
was never connected to the desktop app — high value, low risk. Proposals 5–10
add genuinely new research capability.

| # | Proposal | User story in one line | Status | Effort | Builds on |
| --- | --- | --- | --- | --- | --- |
| 1 | [Session comparison view](01-session-comparison.md) | Compare two or more runs of the same task side by side | Completed (1.3.0) | S/M | Core's combined-session renderer, fully built and unwired |
| 2 | [Workflow deviation detection](02-deviation-detection.md) | Abnormal runs get flagged automatically so I know where to look | Completed (1.4.0) | M | Core's deviation engine, stubbed off in the desktop app |
| 3 | [Context Hotspots view](03-context-hotspots.md) | See which instruction/skill files agents actually load, skip, or overload | Completed (1.5.0) | M | Core's hotspots provider; replaces a sidebar placeholder |
| 4 | [Cost & efficiency analytics](04-cost-analytics.md) | See what sessions, models, and repos actually cost | Completed (1.6.0) | M | Dead `costMicros` plumbing + core pricing in three modes |
| 5 | [Time ranges, filters & drill-down](05-time-ranges-filters-drilldown.md) | Slice any view by time and repository; click a chart to see the sessions behind it | Completed (1.11.0) | M | Repository filter already implemented in SQL, unused |
| 6 | [Session tagging & research notes](06-tagging-notes.md) | Label runs ("experiment-A", "bad-run") and build corpora to compare | Completed (1.11.0) | M | The `RenameStore`/`HiddenStore` JSON-store pattern |
| 7 | [Tool usage analytics](07-tool-analytics.md) | Per-tool call volume, failure rates, and durations — find friction tools | Planned | M/L | Per-tool data all sources already parse and discard |
| 8 | [Rework & churn quality signals](08-rework-churn.md) | Distinguish productive runs from thrashing — the first quality proxy | Planned | L | Per-turn LoC data + Claude `structuredPatch`, unused today |
| 9 | [Session retrospective](09-session-retrospective.md) | Each session tells me what it set out to do, how it went, and what to change | Completed (1.7.0) | M/L | Unread transcript markers + the turn data every source already parses |
| 10 | [AI Helper](10-ai-helper.md) | Ask questions about my own sessions and get grounded, cited answers | Completed (1.8.0) | M/L | Core's chat stack + the Claude CLI backend the deep retrospective already spawns |
| 11 | [Context Improvement Plans](11-context-improvement-plans.md) | Turn hotspot + retro evidence into reviewed, appliable edits to my context files | Completed (1.14.0) | L | The hotspot/retro rankings, the chat-backend registry (now two CLIs), and the deep-retro runner pattern |

**Suggested order:** 1 → 4 → 5 → 2 → 3 → 6 → 7 → 8. Proposal 5's cross-view
navigation ("open Sessions pre-filtered") is reused by 3, 7, and 8 — build it
before or alongside them. Proposal 6 pairs naturally with 1 (tag a set, then
compare it). 7 and 8 are independent of everything else.

Mark a row **Completed**, with the desktop version it shipped in, as each
proposal lands. Proposal 3 ships a minimal cross-view “open this session”
intent; proposal 5 generalized that rather than re-inventing it — `App.tsx` now
holds a `SessionFilterIntent` beside the open intent, and 7 and 8 should land on
that same seam.

Two things proposal 5 settled differently from its own spec, worth knowing
before building on it. Its date filter reads **`ended_at_ms`**, not
`started_at_ms`: the list is ordered by it and the Dashboard buckets its day
columns by it, so a start-time filter would have made a day column open a
different set of sessions than the column counted — and the existing
`idx_sessions_recent` covers it, so no `SCHEMA_VERSION` bump was needed. And the
JS union that used to add rename-matched sessions after the SQL query is gone:
tags and renamed titles now reach the index as key sets passed *into*
`buildFilter`, because anything filtered after `LIMIT` makes offset paging skip
and duplicate.

## Future candidates (no spec yet)

- **Live session watching.** `chokidar@^5` is already a declared dependency of
  the desktop app but is never imported, and core ships
  `src/core/agent-observability-core/src/live/claudeWatcher.ts` and
  `liveUpdateController.ts`. Watching the active transcript would let the list
  and an open detail update while an agent is still running.
- **Export.** Nothing in the product can export a report today. A "Save as
  Markdown/JSON" on the session detail, comparison view, and overview would
  make findings shareable in retros. Local file writes only, user-initiated;
  note `docs/plans/completed/workflow-predicate-dsl.md` already stipulates any
  export path excludes content-derived deviations by construction.
- **Repository detail view.** Core's
  `src/core/agent-observability-core/src/views/sessionDetailHtml.ts` exports
  `renderRepositoryDetailHtml` (whole-repository rollups) — unwired in the
  desktop app; a natural extension of proposal 5's drill-down.

## Ground rules (every agent spec inherits these)

1. **Privacy invariant — absolute.** Raw content (prompts, responses, tool
   I/O, file paths, identities) never leaves the machine. Every feature in
   this folder is **local-only**. Never add fields to the aggregate/sync paths
   (`src/core/agent-observability-core/src/aggregate/*`, `…/src/sync/*`) or to
   `schemas/*.json`. See `docs/privacy-validation.md`. The three sanctioned,
   gated exceptions — all strictly the user's **own AI CLI login** (Claude
   Code to Anthropic, or the GitHub Copilot CLI to GitHub, whichever Settings
   selects), user-initiated, never in the background — are proposal 9's
   opt-in Deep Retrospective (default-off setting plus per-invocation
   confirmation), proposal 10's AI Helper (one-time first-use notice; every
   send an explicit user action), and proposal 11's Context Improvement Plans
   (default-off setting plus per-generation confirmation naming the vendor
   and payload). Proposal 11 also defines the one sanctioned **local write
   path** — allowlisted context files under the re-verified repo root,
   per-file approved, backed up, never deleting. Nothing else may cite any of
   these as precedent.
2. **Core vs. host boundary.** Host-independent logic (parsing, metrics,
   rendering) goes in `src/core/agent-observability-core`; importing `vscode`
   there is a lint error. Desktop-only wiring stays in the desktop package.
   Inside the desktop app, parsing and queries run in the **datahost**
   utilityProcess — never in the renderer or main process. Core is consumed as
   TypeScript source; cross-package imports carry the `/src/` segment
   (`@agent-observability/core/src/…`).
3. **RPC pattern.** New renderer↔datahost calls are added to
   `src/desktop/agent-observability-desktop/src/shared/rpc.ts` and implemented
   in the exhaustive `switch` in
   `src/desktop/agent-observability-desktop/src/datahost/index.ts` — an
   unhandled method is a compile error. Push row updates through the existing
   `sessions.upserted` event so the list updates in place.
4. **Index schema changes.** `index.db` is a disposable cache. To change its
   schema, bump `SCHEMA_VERSION` in
   `src/desktop/agent-observability-desktop/src/datahost/indexer/indexDb.ts`;
   a mismatch **drops and rebuilds** the index — that *is* the migration
   strategy. Never store anything irreplaceable in `index.db`; user-created
   data goes in JSON stores beside `renames.json` (see
   `src/desktop/agent-observability-desktop/src/datahost/renames.ts`).
5. **Versioning + changelog — required for every shipped feature.** In the
   same change: bump `version` in the desktop `package.json` (SemVer; these
   are minor bumps) and add a top entry to the desktop `CHANGELOG.md` in the
   exact parsed shape (`## [x.y.z] - YYYY-MM-DD`, `### Added/Changed/Fixed/
   Removed`, `- item`; only `**bold**`, `` `code` ``, `[links](url)` inline).
   Write it for the user — no file/class/function names. The app renders this
   file in the What's new dialog and its tests parse the real file.
6. **Never commit or push.** Leave finished work in the tree and report what
   changed. See `AGENTS.md`.
7. **Charts are hand-rolled inline SVG** (see
   `src/desktop/agent-observability-desktop/src/renderer/src/views/overview/charts.tsx`).
   Do not add a charting library — the renderer runs under a strict CSP and
   the decision is deliberate.
8. **Verification.** From the repo root: `npm install`, then
   `npm run typecheck -w agent-observability-desktop`,
   `npm test -w agent-observability-desktop`, and
   `npm run typecheck --workspaces --if-present` /
   `npm test --workspaces --if-present` when core was touched. Manual check:
   `npm run dev -w agent-observability-desktop`.
