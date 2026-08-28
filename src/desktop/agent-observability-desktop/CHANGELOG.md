# Changelog

All notable changes to the Agent Observability desktop app are documented in
this file. It is written for the people who use the app, and it is what the
**What's new** dialog inside the app shows — so every entry describes something
a user can see or do differently. Internal work leaves no trace here, which is
why some released versions are absent: they changed nothing you could notice.

The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [1.6.0] - 2026-08-28

### Added

- **Comparing sessions now shows a real diff.** The comparison opens with a
  table: one row per figure — duration, model turns, tool calls, tokens,
  errors, cost, lines added and removed — and one column per session, earliest
  first as the baseline. Every later session carries the change against that
  baseline, as a percentage where one makes sense, coloured green when the run
  did better and red when it did worse. Line counts stay neutral — writing more
  code is a difference, not a verdict — and a session billed in a different
  unit shows a dash for cost rather than pretending to be free. The merged
  totals and per-session sections are still there, below the table.
- **See what your sessions cost.** Each session row now shows its estimated
  cost — priced from published token rates for Claude Code and from billed
  premium-unit usage for Copilot — and the Dashboard gains an estimated-cost
  tile, a cost-per-day chart, a cost-by-model table, and a cost column in the
  by-source table. Sessions that cannot be priced say **n/a** rather than
  pretending to be free, and none of it ever leaves your machine.
- **LLM calls and tool calls at a glance.** Two new Dashboard tiles show how
  many model calls and tool calls your sessions add up to.

### Changed

- **The comparison closes from a labelled button.** A "Close comparison"
  button now sits in the comparison's own header row — instead of an unlabelled
  × floating over the content in the same spot as the Refresh button — and it
  is there from the moment the sessions start loading. Esc still works.

### Fixed

- **The Context Hotspots scrollbar sits at the window edge.** It used to float
  mid-window, at the edge of the table instead of the edge of the view.

## [1.5.0] - 2026-08-28

### Added

- **Context Hotspots is a real view.** It ranks the instruction, skill, agent,
  hook, and prompt files your agents actually pull into context, busiest first,
  with how many sessions used each one, how often it was applied rather than
  skipped or merely read, and how heavy it was. Files over the 2,000-token
  guideline are flagged **Oversized**, and two columns show how often a file was
  in play when a session hit errors or was flagged — the files worth reviewing
  first. Narrow it to one repository, expand a file to see the sessions behind
  it, and click one to open it. All of it is read from your own sessions and
  none of it leaves the machine.

### Changed

- **A renamed session says so when you open it.** The blue dot in the list
  marked a session as renamed, but opening it showed only the new name — with no
  hint the mark referred to anything, and no way to see what the session used to
  be called. The header now carries the same blue dot and the name it replaced.
- **The shorthand on the session view explains itself.** Hovering **LoC**,
  **LoD**, **nLoC**, **nLoD**, or any of the other abbreviations on the agent
  run totals — **MT**, **TC**, **TIN**, **TOUT**, **TCI**, **TT**, **ERR** — now
  says what the figure actually counts rather than just spelling the acronym
  out. The keys under the token trend explain themselves the same way, and
  mention that clicking one filters the plot to that series.

## [1.4.0] - 2026-08-28

### Added

- **Runs that went badly are now flagged for you.** Every recent session is read
  in the background and checked for two things: a request whose tool calls
  failed more often than they succeeded, and a request that ran far longer than
  expected. Sessions with either get a small amber dot in the list, and a
  **Flagged** chip appears above it so you can see only those — the answer to
  "which of last week's runs should I look at first?" without opening any of
  them. This needs no setup.
- **The session says why it was flagged, at the top.** Opening a flagged
  session leads with the reason — the same amber dot as the list, then which
  turn diverged and what happened, in words: "Turn 4 · Ran long — Workflow
  duration (90.5 min) exceeded maximum (60 min)". A card also sits on the
  offending request further down, and the Timeline heading counts them alongside
  the turns. In a comparison, a flagged session keeps its dot while collapsed
  and gives the same explanation when you open it.
- **Settings has an Analysis section** with the turn-length limit behind the
  overlong check, set to 60 minutes to begin with. Changing it re-checks every
  session against the new value.
- If you already describe your workflows in the config file, those checks run
  too — expected steps that were skipped or ran out of order, with the actual
  and expected sequences on the card. Anything derived from the text of a prompt
  or a tool call is marked **Local only**, because it is: none of this leaves
  your machine.

## [1.3.0] - 2026-08-28

### Added

- **Compare several sessions in one view.** Tick two or more sessions in the
  list — the box appears on hover, or hold **Ctrl**/**Cmd** while clicking a
  row — and choose **Compare**. You get a single view with the totals added up,
  a token trend marking where each run starts and ends, and every session below
  it as a section you can open, so it is finally possible to see at a glance
  which run burned more tokens, took more turns, or wrote more code. Searching
  and filtering do not disturb what you have ticked, and **Esc** takes you back
  to the session you were on. Up to ten sessions at a time.
- Claude Code and Copilot sessions can be compared together. They price their
  work differently, so the view picks one basis for the cost figure and says
  which sessions it therefore leaves out of it — everything else, tokens and
  turns and lines of code, still counts every session.

## [1.2.0] - 2026-08-28

### Added

- **Updates now show their download progress.** Choosing to update used to be
  followed by a minute of silence before the restart prompt appeared, with no
  way to tell the download from a hang. A progress bar and percentage now sit
  above the version in the sidebar, with the size and speed on hover, and the
  taskbar icon fills as it goes so you can see it without the window in front.
  A download that fails now says so instead of stopping quietly.

## [1.1.0] - 2026-08-28

### Added

- **What's new** — the sparkle in the sidebar opens this changelog without
  leaving the app.

### Fixed

- **Opening the first Copilot session after launch no longer takes minutes.**
  Everything a session records — prompts, tool definitions, system instructions
  — lives in one table with no way to look a row up by name, so the queries
  behind the detail view had to read the whole thing, which on a well-used
  archive is over a gigabyte. Two of those queries ran on the first session
  opened after launch, which is why only that one was slow. The app now adds the
  missing index to its own archive at startup, once, and nothing is re-imported.

## [1.0.3] - 2026-08-27

### Added

- A **Settings** view: choose which sources are indexed, exclude repositories
  you do not want listed, and point the app at a different database. Changes
  apply straight away and survive a restart.

## [1.0.1] - 2026-08-27

### Added

- **Hide or permanently delete a session.** Hiding takes it out of the list and
  keeps it out; deleting erases the transcript or the telemetry rows for good.
  The dialog names the file it would remove before you confirm.

## [1.0.0] - 2026-08-27

### Added

- First standalone desktop app: a fast, indexed list of your **Claude Code and
  GitHub Copilot** sessions with the full turn-by-turn detail view, reading the
  same on-disk data as the VS Code extension. Nothing leaves the machine.
- A **Dashboard** with charts over the last 30 days, and a progress indicator
  while the session list is being built.
- A **source filter**, so you can look at one tool or both.
- **Rename a session** to something you will recognise later.
- **Dark mode**, following the system appearance, with a toggle in the sidebar.
- A spinner while a large session is being opened, instead of a frozen window.

### Fixed

- Session detail, tab clicks and renames no longer stop working after a refresh.
- Copilot sessions now show the repository they ran against instead of
  "unknown", resolved from the workspace even when the session did not record it.
