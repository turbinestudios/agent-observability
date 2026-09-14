# Changelog

All notable changes to the Agent Observability desktop app are documented in
this file. It is written for the people who use the app, and it is what the
**What's new** dialog inside the app shows — so every entry describes something
a user can see or do differently. Internal work leaves no trace here, which is
why some released versions are absent: they changed nothing you could notice.

The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [1.14.6] - 2026-09-14

### Fixed

- **A telemetry database that is busy is reported as busy**, instead of as
  "Unsupported telemetry schema". Reading Copilot data while another window was
  writing to it could produce a message that pointed at the wrong problem and
  sounded permanent, when waiting a moment was all that was needed.

## [1.14.5] - 2026-09-08

### Fixed

- **Large session timelines do less work before you open them.** Event rows
  are created on demand, with Previous and Next controls for 100-event pages.
  Every event remains available, including in comparisons, and live updates
  preserve the selected page and open sections.
- **Session details and background analysis avoid repeated calculations.**
  Copilot agent-tree and line-count calculations are reused, and context and
  retrospective analysis reuse details already loaded for the session.

## [1.14.4] - 2026-09-08

### Fixed

- **Browse while history is being indexed and analyzed.** Background processing
  no longer holds up searches, dashboard queries, or opening a session. Startup
  opens the saved index without waiting for the full pass, and new sessions fill
  in as they are discovered.
- **Refreshes and settings changes no longer compete with each other.** Repeated
  refreshes are combined, while deletion, rebuilding, and analysis-setting
  changes safely stop old processing before applying. Background failures are
  reported without taking down the interactive data service; Refresh retries.

## [1.14.3] - 2026-09-08

### Fixed

- **Opening and analyzing Copilot sessions no longer copies the entire
  archive.** The app reads the database directly, including newly committed
  activity, without creating a large temporary copy. Session names reuse the
  local index instead of rereading every workspace's chat history.

## [1.14.2] - 2026-09-08

### Fixed

- **Refreshing unchanged Copilot history no longer repeats background analysis
  or reloads the open session.** Completed analysis is reused across refreshes
  and restarts when the recorded data has not changed. New tool and sub-agent
  activity still triggers a fresh analysis.

## [1.14.1] - 2026-09-01

### Fixed

- **GitHub Copilot CLI installed through npm now works on Windows.** npm
  installs the CLI as a `.cmd` launcher, which the app could neither detect
  nor run — the backend check sat on "Checking the AI backend…" forever and
  everything behind it stayed disabled. Both CLIs are now started in a way
  Windows accepts, and a backend that still cannot be reached says why
  instead of hiding both.
- **A disabled "Generate improvement plan" button now says why.** Whether it
  is the Settings toggle, nothing selected yet, an unresolved repository
  checkout, or the AI CLI itself, the reason appears beside the button
  instead of leaving it silently gray.

### Changed

- **Loading states show spinners.** The Improve view shows one while your
  repositories are found, and the Dashboard's "How sessions went" card shows
  one while its first answer is computed.

## [1.14.0] - 2026-08-31

### Added

- **Improvement plans for your context files.** The new **Improve** view lets
  you pick a repository's busiest context files and roughest sessions and get
  a concrete plan — written by your own AI CLI — for how its `CLAUDE.md`,
  `AGENTS.md`, and instruction files should change. Proposed edits show as a
  per-file diff you approve one by one; applied files keep an automatic backup
  with one-click undo, a file changed since the plan was made is refused
  rather than overwritten, and nothing is ever deleted. Off by default —
  turning it on in Settings and confirming each generation are both required,
  because generating sends the selected evidence and the repository's context
  files to your AI vendor through your own login. **Improve context…** buttons
  in Context Hotspots and Retro take you there with the repository pre-picked.
- **GitHub Copilot CLI as a second AI backend.** The AI Helper, deep
  retrospectives, and improvement plans can now run through your own GitHub
  Copilot CLI instead of Claude Code — pick the backend in **Settings → AI**.
  Every consent notice names the vendor your selection actually sends to.

## [1.13.0] - 2026-08-31

### Added

- **The Dashboard now opens with how your sessions went.** A per-day chart
  stacks each day's sessions by their retrospective verdict — went smoothly,
  some friction, struggled, left unfinished — with gray for sessions not
  analyzed yet, so a fresh install colors in as the analysis catches up.
  Click a colored slice to see exactly those sessions.
- **Recurring friction themes.** The friction your retrospectives keep finding
  — correction re-prompts, vague opening prompts, tool-error streaks — ranked
  by how many sessions raised each theme in the window. Click a theme to see
  the sessions behind it.
- **Context hotspots to review.** The context files most worth a look, scored
  0–100 from skip rate, error and deviation co-occurrence, token weight, and
  how often they are applied — the same score the org dashboard uses. Click a
  file to review it in Context Hotspots.

### Changed

- **Cost and volume moved down, not out.** The twelve totals are now a compact
  strip beneath the new insight cards, and the daily cost, token, and session
  charts follow below — everything still answers for the selected window.
- **One-time rebuild on first launch.** This version reads more from each
  session, so the local index rebuilds itself once; the list re-fills over a
  few minutes and nothing is lost.

## [1.12.1] - 2026-08-31

### Fixed

- **Tables in AI Helper answers render as real tables.** When an answer ranks
  sessions or lays out figures side by side, it now appears as a proper table
  that scrolls sideways when wide — instead of one long line of `|` characters.

## [1.12.0] - 2026-08-29

### Added

- **The Dashboard has a time window.** Pick 7, 30 or 90 days — or **All time** —
  and every tile, table and chart on the page answers for that period. Your
  choice is remembered between restarts.
- **Click a chart to see the sessions behind it.** A repository bar, a row in
  **By source**, or a single day column now opens the session list narrowed to
  exactly what you clicked, for the window you were looking at.
- **Filter the session list by repository, date, and tag.** The funnel button
  beside the search box opens the filters; whatever is applied shows as a chip
  above the list, and clicking a chip clears it — so a short list always says
  why it is short.
- **Sessions past the 300th are reachable.** The list used to stop at the first
  three hundred with nothing saying so. A **Load more** button now walks the
  rest, and tells you how many there are.
- **Tag your sessions.** Label runs "experiment-A", "baseline", "bad-run" —
  whatever a comparison needs — from a session's row or from the panel above an
  open session. Tags you have already used are suggested as you type, so a set
  does not split in two over a capital letter. Filter the list to a tag, select
  all of them, and compare.
- **Attach a note to a session.** A free-text note above the open session
  records what actually happened and what you would change; a small ring on the
  row shows that one is there.
- **Your tags and notes are kept safely aside.** They live outside the session
  index, so rebuilding the index never loses them, and they are never part of
  anything sent to the AI Helper or a deep retrospective.

### Changed

- **The Dashboard's totals now follow the selected window.** They used to count
  every session ever recorded while the charts below them showed 30 days, which
  made the two impossible to read together. Choose **All time** for the previous
  behaviour — nothing has been lost.
- **An open session now has a strip along the top** carrying its tags, its note,
  **Ask AI**, and refresh, in place of the buttons that floated over the top-right
  corner of the page.

## [1.10.2] - 2026-08-29

### Fixed

- **An upgrade now truly owns the screen.** Accepting an update while the app
  was still starting could leave the "Starting up…" screen painted over the
  download progress. The download dialog now sits above every other layer, and
  the moment you consent to an upgrade the startup screen retires for good —
  it no longer returns even if you send the download to the background.
- **The Settings scrollbar sits at the window edge again**, instead of floating
  in the middle of the page.

## [1.10.0] - 2026-08-29

### Added

- **The app can now switch Copilot tracing on for you.** VS Code records
  Copilot sessions only while a setting that is off by default is enabled —
  previously you had to edit VS Code's settings file yourself. Now the app
  checks every launch, and when nothing is being recorded it offers to add the
  setting with one click, for every VS Code–based editor on your machine. Your
  settings file keeps its comments and formatting, a setting you deliberately
  turned off is never overridden, and nothing leaves your computer.
- **Settings shows where every editor stands.** The Copilot section now lists
  each detected editor — VS Code, Insiders, Cursor, and the rest — with whether
  tracing is on, an Enable button when it is not, and a Check again button for
  after you restart the editor.
- **Clear instructions when the app can't do it for you.** If a settings file
  can't be edited safely — it has a syntax error, or the app lacks permission —
  the app says so, shows the exact line to add, and opens the file for you.

## [1.9.1] - 2026-08-29

### Added

- **The sidebar now opens with labels beside the icons**, so what each
  destination leads to is readable without hovering it. The collapse button at
  the bottom returns it to the icon strip, and the app remembers which you
  prefer.
- **Copilot is found in VS Code–based editors too.** Every refresh now also
  scans the app folders beside VS Code — Cursor, VSCodium, Windsurf, and any
  other editor built on VS Code — for a Copilot database, so sessions from
  those editors appear without pointing the app at a path by hand.

### Changed

- **"No Copilot database found" now names the switch that creates it.** VS Code
  only writes that database while Copilot Chat's trace exporter is enabled, and
  it is off by default — so a machine can use Copilot daily and still have
  nothing to read. Settings now gives you the exact setting to add, instead of
  suggesting you chat with Copilot again and hope.

### Fixed

- **The download dialog is no longer hidden behind the startup screen.**
  Accepting an update while the app was still starting left the "Starting up…"
  screen covering the download it had just begun. Only one of the two is shown
  now, and it is the download; the startup screen returns if you send the
  download to the background before the app has finished starting.
- **The What's new dialog opens again.** Clicking the sparkle in the sidebar
  appeared to do nothing: the dialog was there, but a layout slip let a long
  changelog push it below the bottom edge of the window. It now opens centered
  on screen, however long the release notes grow.
- On macOS, dialogs now appear above the title strip instead of being cut off
  underneath it.

## [1.9.0] - 2026-08-29

### Fixed

- **The window can be moved again on macOS.** The app is frameless there, and
  content sat directly under the traffic lights with nothing to grab; the top
  edge is now a proper title strip that clears the buttons and drags the
  window.
- **Copilot sessions are found on more machines, with no setup.** The app now
  reads **every** Copilot database it can find — VS Code stable and Insiders
  side by side — instead of only the first one. Previously a stale or
  momentarily unopenable database from one VS Code install could hide the one
  holding all your real sessions.

### Changed

- **"No Copilot database found" now explains itself.** Settings lists exactly
  which locations were checked and what makes the database appear (chat with
  Copilot in VS Code once), instead of leaving a first-time user guessing.
- The status bar now says when a Copilot database was found but holds no agent
  sessions yet, so an empty list is distinguishable from a missing one.

## [1.8.0] - 2026-08-28

### Added

- **Ask your sessions anything.** The AI Helper has arrived: a chat that
  answers questions about your own sessions — what you worked on, which runs
  struggled and why, where the tokens and cost went — grounded in your local
  data and streamed live, with follow-up questions understood in context.
  Answers cite the sessions they draw on by name; click a citation and the
  session opens, scrolled into view in the list. It runs through your own
  Claude Code CLI login on this machine, and a one-time notice explains
  exactly what each message sends before anything is sent at all.
- **Ask about one session in particular.** An **Ask AI** button on the
  session detail attaches that session to the conversation, so "why did this
  run struggle?" gets answered from its actual transcript.
- **A new AI section in Settings.** Point the app at a custom Claude CLI
  install, and pick the model and reasoning effort the AI features use.
- **The app now tells you clearly when the Claude Code CLI is missing.**
  The AI Helper, the deep-retrospective dialog, and Settings all show an
  unmissable warning with the install command and a "Check again" button —
  instead of a cryptic failure after the fact.

### Fixed

- The "Claude Code CLI not found" message no longer points at a VS Code
  setting that does not exist in this app — it now points at Settings here.
- Changing the Claude CLI path now takes effect immediately; previously a
  corrected path could be ignored until the app was restarted.

## [1.7.0] - 2026-08-28

### Added

- **Every session now gets a retrospective.** Open a session and a card under
  the header tells the story: what it set out to do, how it went — went
  smoothly, some friction, struggled, or left unfinished — and the moments
  that decided it, from corrections and interruptions to error streaks and
  rework, each one linking straight to the turn where it happened. It closes
  with up to three suggestions for what to try differently next time. All of
  it is read from your own sessions, on this machine.
- **The list marks the sessions that fought you.** Runs judged struggled or
  left unfinished carry a small chip, and a **Struggled** filter narrows the
  list to just those.
- **A new Retro view.** One table of your recent sessions, worst first: the
  verdict, the friction behind it, and a click straight through to the
  session's full story. Filter by verdict or repository; partial results show
  honestly while the background analysis is still reading.
- **A deep retrospective, strictly opt-in.** Turn it on in Settings and a
  session's retrospective card gains a button that asks your own Claude Code
  login to judge the run — the goal, whether it was reached, and a short
  critique of the opening prompt, written by the model. Every run first shows
  exactly what would be sent and asks you to confirm; the written verdict is
  stored only on this machine.
- **Downloading an update shows its progress.** Choosing **Update now** opens
  a progress window — a real bar, the percentage, the size and speed — instead
  of a silent wait that read as nothing happening. You can send it to the
  background and keep working; the sidebar keeps showing the download, and a
  failure says what went wrong and that nothing on your machine changed.
- **The app explains itself while starting — and keeps you company.** The
  first scan after a launch now says what is happening — finding your
  sessions, then reading them with a running count, then preparing the session
  list and dashboard — instead of a silent window that ignores clicks until it
  finishes. The overlay lifts only once both are ready, so the first thing you
  click responds immediately. Longer waits rotate through playful status
  lines, and opening a session gets the same treatment while it loads.

### Fixed

- **The app no longer fills your disk with Copilot data copies.** Reading
  Copilot sessions works from a temporary copy of their database, and copies
  stranded by a crash or an app quit piled up in the system temp folder forever
  — gigabytes each — until the disk ran out. Copies now live in the app's own
  data folder, every launch cleans up leftovers (including old strandings in
  the temp folder), and running out of room now says plainly how much space is
  needed instead of failing with a cryptic error.
- **The session list says when it is updating.** A slow search or filter
  change used to replace the rows with no sign anything was happening; a
  spinner now floats over the middle of the list while it works, and the rows
  underneath stay scrollable. The filter chips are also organized into two
  rows — sources on one, **Flagged**, **Struggled**, and **Hidden** on their
  own — instead of one strip that pushed the newest chip out of reach.

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
