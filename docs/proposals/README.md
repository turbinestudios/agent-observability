# Desktop App: Research-Functionality Proposals

Nineteen proposals for new functionality in the **Agent Observability desktop app**
(`src/desktop/agent-observability-desktop`), aimed at two goals: better
**research into how agents behaved**, and better **feedback into the developer's own
working practices** (prompts, instruction files, workflows, cost).

Each proposal is one file: a human-readable **user story** with acceptance
criteria, followed by a **self-contained agent spec** that can be handed to an
implementation agent as-is ("implement `docs/proposals/NN-slug.md`"). Specs
embed the concrete file paths and existing assets they build on, so no
re-exploration is needed.

Proposals 1–4 are mostly wiring capability that **already exists in core** but
was never connected to the desktop app: high value, low risk. Proposals 5–13
add genuinely new research capability. Proposals 14–19 take the app from
observing sessions to judging them and starting the next one.

| # | Proposal | User story in one line | Status | Effort | Builds on |
| --- | --- | --- | --- | --- | --- |
| 1 | [Session comparison view](01-session-comparison.md) | Compare two or more runs of the same task side by side | Completed (1.3.0) | S/M | Core's combined-session renderer, fully built and unwired |
| 2 | [Workflow deviation detection](02-deviation-detection.md) | Abnormal runs get flagged automatically so I know where to look | Completed (1.4.0) | M | Core's deviation engine, stubbed off in the desktop app |
| 3 | [Context Hotspots view](03-context-hotspots.md) | See which instruction/skill files agents actually load, skip, or overload | Completed (1.5.0) | M | Core's hotspots provider; replaces a sidebar placeholder |
| 4 | [Cost & efficiency analytics](04-cost-analytics.md) | See what sessions, models, and repos actually cost | Completed (1.6.0) | M | Dead `costMicros` plumbing + core pricing in three modes |
| 5 | [Time ranges, filters & drill-down](05-time-ranges-filters-drilldown.md) | Slice any view by time and repository; click a chart to see the sessions behind it | Completed (1.12.0) | M | Repository filter already implemented in SQL, unused |
| 6 | [Session tagging & research notes](06-tagging-notes.md) | Label runs ("experiment-A", "bad-run") and build corpora to compare | Completed (1.12.0) | M | The `RenameStore`/`HiddenStore` JSON-store pattern |
| 7 | [Tool usage analytics](07-tool-analytics.md) | Per-tool call volume, failure rates, and durations, to find friction tools | Completed (1.19.0) | M/L | Per-tool data all sources already parse and discard |
| 8 | [Rework & churn quality signals](08-rework-churn.md) | Distinguish productive runs from thrashing (the first quality proxy) | Completed (1.23.0) | L | Per-turn LoC data + Claude `structuredPatch`, unused today |
| 9 | [Session retrospective](09-session-retrospective.md) | Each session tells me what it set out to do, how it went, and what to change | Completed (1.7.0) | M/L | Unread transcript markers + the turn data every source already parses |
| 10 | [AI Helper](10-ai-helper.md) | Ask questions about my own sessions and get grounded, cited answers | Completed (1.8.0) | M/L | Core's chat stack + the Claude CLI backend the deep retrospective already spawns |
| 11 | [Context Improvement Plans](11-context-improvement-plans.md) | Turn hotspot + retro evidence into reviewed, appliable edits to my context files | Completed (1.14.0) | L | The hotspot/retro rankings, the chat-backend registry (now two CLIs), and the deep-retro runner pattern |
| 12 | [Workspace: live board & repository hubs](12-workspace-live-board.md) | See every agent session running right now, and what each repository has taught my agents | Completed (1.16.0) | L | Core's unwired `ClaudeWatcher`/`LiveUpdateController`, repo-scoped SQL over the existing index, the retro advice table |
| 13 | [Team perspective](13-team-perspective.md) | See how my team uses agents, anonymously, through a shared folder and no server | Completed (1.17.0) | L | The aggregate and context-insights builders, the retro verdict projection, the repo-sync policy, the JSON-store pattern |
| 14 | [Copilot CLI as a session source](14-copilot-cli-source.md) | See my terminal Copilot sessions beside Claude Code and VS Code Copilot | Completed (1.18.0) | M/L | The `SessionDataSource` seam, the Claude indexer's two-phase shape, the live board |
| 15 | [Run: host Copilot sessions in the app](15-run.md) | Start or continue a Copilot session from a finding, approving each action as it comes | Completed (2.0.0) | L | Proposal 14's source, the AI Helper's streaming path, the Copilot SDK driving the installed CLI |
| 16 | ["Did it really finish?"](16-done-claim-check.md) | See what was and was not observed about a session's completion before trusting "done" | Completed (1.20.0) | M/L | Transcript commands and edits (the new `SessionActivity` chokepoint), the retrospective |
| 17 | [Attention inbox](17-attention-inbox.md) | One ranked list of what needs me now and what finished while I was away | Completed (1.21.0) | M | The live board, verdicts, completion checks, the JSON-store pattern |
| 18 | [Review packet](18-review-packet.md) | Give a reviewer the story of a session before the diff, ready to paste into a pull request | Completed (1.22.0) | M | `SessionActivity`, the retrospective, the digest's builder/renderer split |
| 19 | [Hand-off brief and Resume in terminal](19-handoff-brief.md) | Start the next session where this one stopped, with my constraints carried over | Completed (1.22.0) | M | `SessionActivity`, the redaction helper, the user's own `claude` / `copilot` |

**Suggested order.** Proposals 1–6 and 9–13 are built. What remains runs on
two tracks that touch mostly different files and can be built in parallel:

- **Run track:** 14 → Resume in terminal (ships with 19) → 15.
- **Evidence track:** 7 → 16 → 8 → 17 → 18 + 19.

Proposal 7 carries the Evidence track's one index schema bump and the
`analysis_version` key, so it goes first. Proposal 16 introduces
`SessionActivity`, the single module that reads command and edit inputs,
which 8, 18 and 19 reuse. Proposal 15 needs 14 (hosted sessions reach the
index only through that source) and takes proposal 19's brief as a prefill.
Proposal 5's cross-view navigation ("open Sessions pre-filtered") is the seam
every new drill-down lands on.

Mark a row **Completed**, with the desktop version it shipped in, as each
proposal lands. Proposal 3 ships a minimal cross-view “open this session”
intent; proposal 5 generalized that rather than re-inventing it: `App.tsx` now
holds a `SessionFilterIntent` beside the open intent, and 7 and 8 should land on
that same seam.

Two things proposal 5 settled differently from its own spec, worth knowing
before building on it. Its date filter reads **`ended_at_ms`**, not
`started_at_ms`: the list is ordered by it and the Dashboard buckets its day
columns by it, so a start-time filter would have made a day column open a
different set of sessions than the column counted. The existing
`idx_sessions_recent` also covers it, so no `SCHEMA_VERSION` bump was needed. And the
JS union that used to add rename-matched sessions after the SQL query is gone:
tags and renamed titles now reach the index as key sets passed *into*
`buildFilter`, because anything filtered after `LIMIT` makes offset paging skip
and duplicate.

## Future candidates (no spec yet)

- **Export.** Nothing in the product can export a report today. A "Save as
  Markdown/JSON" on the session detail, comparison view, and overview would
  make findings shareable in retros. Local file writes only, user-initiated;
  any export path must exclude content-derived deviations by construction.
  Proposal 18's review packet covers the single- and multi-session case as
  copy-to-clipboard Markdown; saving to a file and exporting the overview are
  what is left.
- **Repository detail view.** Core's
  `src/core/agent-observability-core/src/views/sessionDetailHtml.ts` exports
  `renderRepositoryDetailHtml` (whole-repository rollups), still unwired in the
  desktop app. Proposal 12's repository hub covers the same ground with the
  index; the renderer could still be reused for an exportable HTML report.

## Ground rules (every agent spec inherits these)

1. **Privacy invariant (absolute).** Raw content (prompts, completions, tool
   I/O, file paths, identities, branch and commit names) never leaves the
   machine. The only data that leaves it is schema-bound aggregates: the
   opt-in aggregate batch (`schemas/aggregate-batch.schema.json`, with
   `schemas/context-insights-batch.schema.json`) uploaded by the extension,
   and proposal 13's opt-in team shard (`schemas/team-shard.schema.json`), a
   file written to a user-chosen shared folder that embeds those two batches
   unchanged plus session-outcome counts. Cloud sharing is off by default and
   needs explicit consent plus an API key in VS Code SecretStorage. The
   dashboard address is the user setting `agentObservability.sync.dashboardUrl`,
   which is application-scoped (a workspace can never redirect the API key)
   and accepts only `https://` addresses. Every feature in this folder is
   **local-only**, with proposal 13's shared-folder exchange as the one
   sanctioned file-exchange path. Never add fields to the aggregate/sync/team
   paths (`src/core/agent-observability-core/src/aggregate/*`, `…/src/sync/*`,
   `…/src/team/*`) or to `schemas/*.json`; the team shard may only embed the
   two batch schemas by reference, never copy or extend them. See the privacy
   invariant in `AGENTS.md` and
   `docs/privacy-validation.md`. Proposal 15's Run is covered by its own
   clause in `AGENTS.md`, "The app as agent host": off by default, ask-only,
   never in the background, never on the sharing paths; it is not one of the
   exceptions below and none of them may be cited to widen it. There are three sanctioned, gated
   exceptions. All are desktop-only, all use strictly the user's **own AI CLI
   login** (Claude Code to Anthropic, or the GitHub Copilot CLI to GitHub,
   whichever Settings selects), and all are user-initiated, never run in the
   background, and never touch the aggregate/sync path. They are proposal 9's
   opt-in Deep Retrospective (default-off setting plus per-session
   confirmation), proposal 10's AI Helper (one-time first-use notice; every
   send an explicit user action), and proposal 11's Context Improvement Plans
   (default-off setting plus per-generation confirmation naming the vendor
   and payload). Proposal 11 also defines the one sanctioned **local write
   path**: allowlisted context files under the re-verified repo root, each
   approved individually after a diff preview, refused when changed since
   generation, backed up, never deleting. Nothing else may cite any of these
   as precedent.
2. **Core vs. host boundary.** Host-independent logic (parsing, metrics,
   rendering) goes in `src/core/agent-observability-core`; importing `vscode`
   there is a lint error. Desktop-only wiring stays in the desktop package.
   Inside the desktop app, parsing and queries run in the **datahost**
   utilityProcess, never in the renderer or main process. Core is consumed as
   TypeScript source; cross-package imports carry the `/src/` segment
   (`@agent-observability/core/src/…`).
3. **RPC pattern.** New renderer↔datahost calls are added to
   `src/desktop/agent-observability-desktop/src/shared/rpc.ts` and implemented
   in the exhaustive `switch` in
   `src/desktop/agent-observability-desktop/src/datahost/index.ts`; an
   unhandled method is a compile error. Push row updates through the existing
   `sessions.upserted` event so the list updates in place.
4. **Index schema changes.** `index.db` is a disposable cache. To change its
   schema, bump `SCHEMA_VERSION` in
   `src/desktop/agent-observability-desktop/src/datahost/indexer/indexDb.ts`;
   a mismatch **drops and rebuilds** the index; that *is* the migration
   strategy. Never store anything irreplaceable in `index.db`; user-created
   data goes in JSON stores beside `renames.json` (see
   `src/desktop/agent-observability-desktop/src/datahost/renames.ts`).
5. **Versioning and changelog are required for every shipped feature.** In the
   same change: bump `version` in the desktop `package.json` (SemVer; these
   are minor bumps) and add a top entry to the desktop `CHANGELOG.md` in the
   exact parsed shape (`## [x.y.z] - YYYY-MM-DD`, `### Added/Changed/Fixed/
   Removed`, `- item`; only `**bold**`, `` `code` ``, `[links](url)` inline).
   Write it for the user, with no file/class/function names. The app renders this
   file in the What's new dialog and its tests parse the real file.
6. **Never commit or push.** Leave finished work in the tree and report what
   changed. See `AGENTS.md`.
7. **Charts are hand-rolled inline SVG** (see
   `src/desktop/agent-observability-desktop/src/renderer/src/views/overview/charts.tsx`).
   Do not add a charting library: the renderer runs under a strict CSP and
   the decision is deliberate.
8. **Verification.** From the repo root: `npm install`, then
   `npm run typecheck -w agent-observability-desktop`,
   `npm test -w agent-observability-desktop`, and
   `npm run typecheck --workspaces --if-present` /
   `npm test --workspaces --if-present` when core was touched. Manual check:
   `npm run dev -w agent-observability-desktop`.
