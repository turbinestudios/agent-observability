# Agent Observability desktop app

A desktop app for macOS and Windows that lets you look back at your
**GitHub Copilot** and **Claude Code** sessions. It reads the same data as the
VS Code extension, opens much faster, and works without VS Code running. You
can use both at the same time.

## Features

- **Sessions:** one list of every session, with search, filters, tags, notes,
  renaming and hiding.
- **Session detail:** each turn with tokens, tools, time and a token trend.
- **Compare:** up to 10 sessions side by side.
- **Cost:** estimates for Claude from token prices and for Copilot from premium
  usage.
- **Flags and retrospectives:** sessions that ran long or drifted are marked,
  and each session gets a short retrospective. The **Retro** view collects
  them.
- **Context Hotspots:** which instruction files, skills and prompts your agents
  read, and how those sessions went.
- **Dashboard:** your activity over a time window you choose, with drill-down.
- **Improve:** a suggested plan for your context files, which you can apply
  one approved change at a time.
- **AI Helper:** ask questions about your sessions.
- **What's new:** release notes in the app, from the sparkle at the bottom of
  the sidebar.

## Install

Download the installer from
[Releases](https://github.com/turbinestudios/agent-observability/releases).

- **macOS:** pick `arm64` for Apple Silicon or `x64` for Intel; the wrong one
  will not start. Open the `.dmg` and drag the app to Applications. The app is
  signed and notarized, so it opens normally.
- **Windows:** run the `.exe`. The installer is not signed yet, so SmartScreen
  shows "Windows protected your PC". Choose **More info**, then **Run anyway**.

The app checks GitHub for a new version when it starts and tells you when one
is out. Nothing is downloaded or installed without asking you first. The check
sends no session data.

## First launch

- **Claude Code** sessions appear on their own.
- **Copilot** sessions only exist if Copilot tracing is turned on, and it is
  off by default. If the app finds nothing, it offers to turn it on for every
  VS Code-based editor on your computer. You can also do it under
  **Settings > Copilot**. Restart the editor afterwards.

## Run a session

Off by default. Turn it on under **Settings > Run** and a **Run** entry
appears in the sidebar. There you can start a GitHub Copilot session in one of
your repositories, or continue a Copilot CLI session, and follow it as it
works.

- It uses your own installed `copilot` and your own Copilot login. The app
  ships no Copilot runtime and holds no key.
- What goes to GitHub is your message and whatever the agent then reads in
  that repository, exactly as when you run `copilot` in a terminal. The
  repository's instruction files apply in the same way.
- Every action asks first. Before the agent writes a file or runs a command
  you see what it wants to do and choose **Allow once**, **Allow for this
  session** (for that kind of action: reading files, changing files, a
  named command) or **Deny**. Nothing is remembered after the session.
- If you would rather not be asked, pick **Allow all** under Permissions for
  that one session. It is the same as starting `copilot --allow-all`: the
  agent changes files, runs commands and opens web addresses without
  asking. It asks you to confirm, applies to that session only, and every
  new session starts on **Default permissions** again.
- Buttons elsewhere in the app, such as **Start a session with this digest**
  or **Apply this plan with an agent**, only fill in the goal box. Nothing is
  sent until you press **Start**.
- The session is saved with your other Copilot CLI sessions, so you can
  continue it in a terminal with `copilot --resume`.
- Claude Code sessions are never run from the app. **Resume in terminal**
  opens your own terminal on the session instead.

## Privacy

Your sessions are read on your computer and stay there. The Team view and
team sharing are both off by default. If you turn them on under
**Settings > Team** and choose a folder
your team shares, the app writes one JSON file there, named after your
anonymous id, with counts and totals only: sessions, tokens, estimated cost,
how sessions went, repositories, and the repo-relative paths of context files
such as `AGENTS.md`. It reads the files your teammates put in the same folder.
There is no server, and **Preview what will be shared** shows the exact file
first.

Three optional AI features send content, only when you ask, through your own
Claude Code or GitHub Copilot CLI login (choose which in **Settings > AI**):

- **Deep Retrospective** is off by default. When it is on, you confirm each
  time, and one session's summary is sent to write a retrospective.
- **AI Helper** shows a notice the first time. Each message you send carries
  your question, a summary of recent sessions, and parts of any session you
  attach.
- **Context Improvement Plan** is off by default. When it is on, you confirm
  each time, and the selected files' usage figures, the selected sessions'
  findings, and your context files are sent to write the plan.

Applying a plan changes only the context files you approve, one diff at a
time, after taking a backup, and never deletes anything. The full rules are in
[AGENTS.md](../../../AGENTS.md#privacy-invariant-do-not-break).

## Development

```bash
npm install                                      # at the repo root; this is a workspace
npm run dev     -w agent-observability-desktop   # hot reload
npm run build   -w agent-observability-desktop
npm test        -w agent-observability-desktop
npm run package -w agent-observability-desktop   # installers in release/
```

Local builds do not check for updates. Only official release builds do.

Benchmarks (bundle first, then run):

```bash
npx esbuild scripts/benchmark.ts --bundle --platform=node --format=cjs \
  --external:better-sqlite3 --outfile=scripts/benchmark.js && node scripts/benchmark.js
```

`compare.ts` runs the extension's approach and this one over the same data,
which is where the table below comes from.

### Architecture

```
main            thin broker: window, theme, open-external, and the handshake
                that hands the renderer a direct port to the data host
renderer        React + Vite. Sessions is the left nav; other views open beside it
data host       utilityProcess serving interactive index queries, details, and AI requests
background      worker thread indexing/analyzing with its own WAL connection
```

Core's session API is synchronous, so it never runs on the main or renderer
thread, where a slow parse would freeze the window. It is wrapped in promises
once, at the MessagePort boundary.

Only the broker creates or migrates the index. Background workers expect the
schema to exist already and are thrown away after each pass. The worker entry
is bundled beside the broker and shipped by the `out/**` package rule.
Requested detail and combined renders still run synchronously in the broker.
Copilot reuses one tree walk and parsed write deltas per read, with binary
search to attribute them to turns. Context and retrospective analysis reuse
the caller's detail instead of rebuilding it.

Sessions with more than 100 events load their event rows only when a timeline
opens. Previous and Next show at most 100 rows per open timeline, and live
updates keep the selected page. Compact event metadata stays in the document
as escaped, inert data. Prompts, turn headings, charts and context panels are
still rendered up front. This limits event DOM work, not total session size,
and adds no network requests or sandbox changes.

### Indexing

The extension builds its session list by parsing transcripts when asked, so
the list cannot appear until hundreds of megabytes have been read. This app
keeps an index at `~/.agent-observability/desktop/index.db` and does that work
once, in the background.

Measured on a real set of 686 Claude transcripts (805 MB) and a 1.6 GB Copilot
archive, 230 sessions in all. These figures cover the first indexed rows and
query time, **not** full startup:

| | Indexer / list-query time |
| --- | --- |
| Extension, Claude (parse when asked) | 3,696 ms, capped at 150 sessions |
| Extension, Copilot (copy + WAL replay) | 68,365 ms for 47 sessions |
| Desktop, first indexed rows | **76 ms**, before full hydration |
| Desktop, warm list query | **0.8 ms**, all 230 sessions, uncapped |

The Copilot rows match the extension's exactly (same 47 sessions, step counts,
titles and repositories). Speed is worth nothing if the data differs.

How the index stays fast:

- **List first, parse later.** A `readdir`/`stat` walk gives ids and modified
  times, enough to show a complete, correctly ordered list. Counts fill in
  afterwards, newest first.
- **Claude fingerprints.** A transcript whose size and modified time have not
  changed is not parsed again.
- **Copilot's database is read in place.** The extension's SQLite driver cannot
  open a WAL database, so it copies all 1.6 GB and replays the WAL by hand on
  every refresh. `better-sqlite3` reads WAL directly, so indexing needs no copy
  and uses aggregate queries. Nothing is ever written to Copilot's file.
- **Titles are indexed once.** They live in per-workspace stores of about 4 GB
  in total, which the extension rereads on every refresh. Here a store that has
  not changed is skipped, and a changed session file is read only up to its
  first line.
- **Stable Copilot revisions.** When source metadata and database/WAL
  fingerprints are unchanged, each row keeps its revision, cached detail and
  saved analysis, and only changed rows are sent to the window. Any database or
  WAL change invalidates the Copilot set, including edits that do not change
  any summary count.
- **Detail and analysis read the archive in place too**, with core's own
  queries and schema checks. A short read-only transaction pins each request's
  view and closes before returning, so WAL commits are visible to the next
  request and no idle reader blocks checkpointing. Titles come from the local
  index laid over archived names, not from scanning chat content.

Indexing and analysis run in their own worker thread with their own SQLite WAL
connection. The data host reads the saved index while the worker parses and
writes short transactions. Startup waits only for the queries the window needs,
not the background pass, so even on a first install you can move around while
the list fills in.

Bursts of refreshes merge into one follow-up run. Deleting, rebuilding, and
changes to settings or context analysis wait for the worker to stop before
touching the index, so an old pass cannot bring back removed rows or old
verdicts. The worker finishes any archive maintenance it holds a lease for
before it can be stopped. Late events from stopped workers are ignored, and the
broker adds the latest names, tags, notes and hidden state to row
notifications. A crash reports an error and can be retried with Refresh,
without a restart loop. Claude hydration saves each summary together with its
file fingerprint, so an interrupted worker cannot mark old counts as current.

Copilot change tokens live in a separate table next to the index, so upgrading
does not rebuild the index. The first refresh records a baseline for existing
rows, and later unchanged refreshes reuse it. An unknown token, or a database
that changes during a read, forces a fresh check instead of keeping analysis
that might be stale.

The index is a cache and holds nothing that cannot be rebuilt. Deleting it, or
using **Rebuild index**, is always safe.

The extension still uses its WASM snapshot reader. The desktop app does not
quietly fall back to copying when it cannot read a source: it reports the
failure or uses another source it found. Startup still cleans up temporary
snapshots left by older versions.
