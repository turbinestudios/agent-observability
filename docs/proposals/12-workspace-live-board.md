# 12. Workspace: live board and repository hubs

## User story

As a developer running several agent sessions across several repositories, I
want one place that shows what every session is doing right now and, per
repository, what my agents have learned there, so that I stop juggling
terminals to see who is waiting for me and stop re-deriving the same lessons
about a codebase session after session.

**Acceptance criteria**

- A **Workspace** entry in the sidebar opens a view whose top section, **Now**,
  lists every Claude Code and Copilot session active in the last 30 minutes,
  across all repositories, each with a status of **working**, **waiting for
  you**, **idle** or **finished**, its repository, branch, start time, last
  activity, tokens and estimated cost so far. Clicking a card opens the
  session in the Sessions view.
- Status is derived from the tail of the session's own transcript on this
  machine. No hook, exporter or plugin is installed into either agent, and no
  session is launched, resumed or steered from the app.
- A card flips within about a second of the agent writing to its transcript;
  a session with no writes for 3 minutes shows **idle**, after 30 minutes
  **finished**, and leaves the board an hour after its last activity.
- An optional desktop notification (off by default; **Settings > Workspace**)
  fires when a session goes from working to waiting for you, or finishes, from
  whichever view is open.
- Below the board, one card per repository active in the chosen window (7, 30,
  90 days or all time) shows sessions, verdict mix, cost, sources and live
  counts, and opens a **repository hub** with: live and recent sessions; how
  sessions went with a trend against the equal-length previous window;
  recurring friction, each theme drilling into the Sessions view; a **Rules &
  skills** table of the context files found on disk in the checkout joined
  with how often sessions loaded or skipped each one; the repository's Context
  Improvement Plans; and models with spend.
- The hub can build a **"What the agents learned here"** digest entirely on
  this machine and copy it as Markdown; the digest carries no session text,
  no absolute paths and no branch names. An **Ask AI Helper about this
  repository** button opens the AI Helper with a question filled in and sends
  nothing until the user presses Send.
- The session list and the Dashboard refresh on their own shortly after a
  transcript changes, without the user pressing Refresh.

## Why this matters for research

Every earlier proposal looks back at sessions one at a time or in aggregate.
This one adds the two angles a cockpit has and an observer lacked: the present
tense (which session needs me now) and the repository as the unit of learning
(what has this codebase taught my agents, and which of its rules do they
actually read). The digest turns the per-session evidence proposals 3, 9 and 11
already produce into something a team can paste into a retro or a wiki, with
no vendor call.

## Agent spec

**Goal.** A hook-free live board over the transcripts the agents already write,
repository-scoped queries over the existing index, an on-disk inventory of
context files joined with their usage, and a pure digest builder. One new rail
entry, four new RPCs, one push event, one setting. No index schema change
(`SCHEMA_VERSION` stays 5). Nothing new on any aggregate or sync path.

**Grounding: what exists (all shipped with this proposal)**

- Core, pure: `src/core/agent-observability-core/src/live/liveStatus.ts`
  (`deriveTailFacts`, `deriveLiveStatus`, `LIVE_IDLE_MS`, `LIVE_FINISHED_MS`,
  `PENDING_TOOL_HINT_MS`); `claude/transcriptTail.ts` (`readTranscriptTail`,
  reads the last 256 KiB only); `context/contextInventory.ts`
  (`scanContextInventory`, `classifyInventoryPath`, never reads contents);
  `analysis/repositoryDigest.ts` (`buildRepositoryDigest`,
  `renderRepositoryDigestMarkdown`); `analysis/retrospective.ts` now exports
  `evaluateAdvice` so tips can be ranked across sessions.
- Core, already there and now wired: `live/claudeWatcher.ts` and
  `live/liveUpdateController.ts`.
- Desktop datahost: `datahost/live/fsWatchFactory.ts` (core's
  `FileWatchFactory` over `fs.watch`; chokidar was removed as ESM-only and
  unused), `datahost/live/liveBoard.ts` (`LiveBoardService`: seeds candidates
  from discovery, recomputes on debounced events and a 30 s tick, emits
  `workspace.live` only on change, requests a quiet-period re-index),
  `datahost/workspace/repoHub.ts` (`buildRepositoryCards`, `buildRepoHub`,
  `buildRepoDigestInput`), `datahost/workspace/contextInventory.ts` (the
  inventory ↔ usage join by normalized absolute path), new `IndexDb` queries
  (`repositoryCards`, `repoTotals`, `repoVerdicts`, `repoThemes`,
  `repoModels`, `repoSessionFindings`) and `staleAnalysis(batch, window,
  settledBeforeMs)` so a live-triggered pass skips still-moving transcripts
  (`BackgroundInput.skipAnalysisNewerThanMs`).
- RPC: `workspace.live`, `workspace.repositories`, `workspace.repoHub`,
  `workspace.repoDigest`; event `workspace.live`; setting
  `workspace.notifications` (`SettingsSnapshot.liveNotifications`).
- Renderer: `views/workspace/*` (`WorkspaceView`, `LiveBoard`,
  `RepositoryCards`, `RepoHub`, `DigestDialog`, pure `workspace.ts`,
  `liveNotifications.ts`, `digest.ts`, hooks in `useLiveBoard.ts`),
  `views/overview/WindowSelector.tsx` (extracted from the Dashboard and
  shared), the `Workspace` rail entry, `App.tsx` mounting the notification
  hook in the shell, `AssistantView`'s `AskAiIntent` widened with `prefill`,
  the Settings card.

**Constraints**

- **Privacy.** Branch names and checkout roots are LOCAL-ONLY display and
  never enter the digest Markdown, any aggregate, or any AI payload. The
  digest's hotspot paths are made repo-relative (or reduced to the file name)
  in the datahost before they reach the renderer. The "Ask AI Helper" door is
  only a prefilled question into the existing sanctioned AI Helper (exception
  2): no new vendor call, no new exception.
- **Hook-free, by decision.** A tool call waiting for permission is
  indistinguishable from one running; the board shows it as working and hints
  "may be waiting for your approval" after 90 seconds. Do not install hooks to
  fix this.
- The status module and the digest module import nothing from `node:*`; the
  renderer bundles them.
- Tail reads only: never parse a whole transcript on the live path. The index
  pass (requested after 10 s of quiet) owns the full parse.
- Charts are hand-rolled inline SVG and CSS; the verdict bar aliases the retro
  colour ramp.

**Out of scope**

- Copilot CLI (`~/.copilot/session-state`) as a source; Copilot rows on the
  board are activity-based from the index only.
- Launching, resuming, forking or steering sessions; git worktrees.
- Exact permission-prompt detection (needs hooks).
- Persisted per-tool analytics (proposal 7); the digest samples the 8 most
  recent sessions and says so.

**Verification**

- `npm run typecheck --workspaces --if-present`, `npm run lint --workspaces
  --if-present`, `npm test --workspaces --if-present` from the repo root.
- Manual (`npm run dev -w agent-observability-desktop`): start a Claude Code
  session; its card appears as **working** and flips to **waiting for you**
  within about a second of the turn ending; stop for 3 minutes and it reads
  **idle**. Turn notifications on in Settings and confirm a toast on the next
  flip. Open a repository hub, copy the digest, and confirm the Markdown holds
  no absolute paths or branch names. Press **Ask AI Helper about this
  repository** and confirm the box is filled and nothing is sent. Confirm no
  `claude` or `copilot` process starts from the Workspace view.
