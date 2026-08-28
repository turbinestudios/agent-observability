# Changelog

All notable changes to the Agent Observability (Local) extension are documented
in this file. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.16] - 2026-08-28

### Fixed

- **Opening the first Copilot session after startup no longer takes minutes.**
  The telemetry database stores every prompt, tool definition and system
  instruction in one table keyed by span, with nothing to look rows up by
  attribute name — so three of the queries behind the detail view had to read
  the entire table, which on a well-used archive is well over a gigabyte. Two of
  them run on the first session opened after startup, which is why that one
  session was slow and the rest were not. The archive now carries an index for
  those lookups, added automatically the next time the extension writes to it,
  so no action is needed and nothing is re-imported. Measured on a 1.6 GB
  archive, the first session opened went from 8.9s to 2.4s of query time, and
  each later one is quicker too.
- Machines with no archive yet — where sessions are read straight from Copilot's
  own database, which this extension never writes — get the same speed-up
  applied to the private read-only copy it takes instead.


## [0.9.15] - 2026-08-27

### Added

- **The session detail header now shows which repository the session ran
  against**, linked so it opens on GitHub. Sessions whose remote could not be
  resolved simply omit the row rather than displaying "unknown", and a remote
  that is not a web URL — an ssh remote, a local path — is shown as plain text
  instead of a link that would go nowhere.
- Cloud agent sessions that carry a run URL now show an **Open on GitHub** link
  in the same header. The field already existed on the model but was never
  rendered.

## [0.9.14] - 2026-08-27

### Changed

- The rule deciding which span groups count as real sessions — the one that
  keeps tool-call ids and chat-helper traffic out of the Sessions list — moved
  into its own module with direct test coverage. Behavior is unchanged; it now
  has a single definition shared with the desktop app, which reads the same
  database and would otherwise have needed its own copy of a filter subtle
  enough to drift silently.

## [0.9.13] - 2026-08-27

### Changed

- The session-detail renderer takes an optional `extraHeadHtml` argument, so a
  host can inject nonce-tagged markup into the document head. The extension
  passes nothing and renders exactly as before; the desktop app uses it to
  supply the theme variables the document's CSS reads. Shared code, one
  renderer, no fork.

## [0.9.12] - 2026-08-27

### Changed

- **The bulk of the extension now lives in a shared `@agent-observability/core`
  package** — session sources and parsing, the telemetry and SQLite layer,
  aggregation, sync, deviation and context analysis, the OTLP stack, and the
  session-detail renderers. The extension keeps the VS Code surface: tree views,
  the detail panel, the AI Helper webview, commands, and the host adapters.
  Nothing about the extension's behavior, settings, or data handling changes —
  core is compiled into `dist/extension.js` exactly as before, and the full test
  suite moved with the code, passing unchanged.

  The point is a second consumer: a standalone desktop app can now read the same
  sessions through the same code. Importing `vscode` from core is a lint error,
  so the boundary cannot erode silently.

## [0.9.11] - 2026-08-27

### Changed

- **The last three VS Code couplings in otherwise host-independent modules are
  now behind seams**, so those modules can be shared with a standalone desktop
  app without forking them. No behavior change; all settings, sync state, and
  chat cancellation work exactly as before.
  - `Configuration` reads through a new `SettingsReader` interface instead of
    calling `vscode.workspace.getConfiguration` itself. The VS Code binding
    moved to `config/vscodeSettings.ts`; every typed accessor is untouched.
  - `GlobalStateSyncStateStore` moved to its own `sync/globalStateSyncStateStore.ts`,
    leaving `sync/syncState.ts` (the store contract and its in-memory
    implementation) free of any `vscode` reference. Each store now has its own
    tests covering watermark round-trip and ring-buffer eviction.
  - Chat backends take a host-neutral `CancellationToken` from
    `chat/backends/cancellation.ts`; `vscode.CancellationToken` is structurally
    assignable to it, so callers pass their tokens through unchanged.

## [0.9.10] - 2026-08-27

### Changed

- **The repository is now an npm workspace.** `npm install` runs at the repo
  root and installs for every package; the extension's own lockfile is gone in
  favour of a single root `package-lock.json`. This is the groundwork for a
  shared core package consumed by both this extension and a standalone desktop
  app. Nothing about the extension's behavior changes.
- **`node-sqlite3-wasm` is staged into `dist/node_modules` at build time.**
  Workspaces hoist dependencies to the repo root, so `.vscodeignore` could no
  longer re-include the package from the extension folder — the `.vsix` would
  have installed without its WebAssembly sidecar and failed at runtime. The new
  `scripts/stageSqliteWasm.js` copies it into `dist/`, which ships wholesale and
  is where Node resolution looks first. Packaging now uses
  `vsce package --no-dependencies`, since dependency listing via `npm list` is
  unreliable inside a workspace.
- Dev-only helper scripts (`scripts/**`) no longer ship inside the `.vsix`.

## [0.9.9] - 2026-08-27

### Fixed

- **Sessions from every workspace now connect to their repository — not just
  the current window's.** The repo attribute on telemetry spans is sparse, and
  the only fallback was scoped to the CURRENT workspace, so sessions recorded
  in any other window (WSL windows included) sat in the "unknown" bucket and
  their repositories never appeared in the tree at all. A cross-workspace map
  is now built from every workspace store under
  `<userData>/User/workspaceStorage` — its chat-session ids joined to the
  folder's sanitized git remote (WSL folders are reached over `\\wsl$`). The
  scan is deferred off activation and rebuilt at most every 5 minutes; the
  live current-workspace context still wins for sessions it claims.
- **SSH host aliases in git remotes resolve to their real host.** A remote
  like `git@github-work:owner/repo` (with `Host github-work / HostName
  github.com` in `~/.ssh/config` — the common second-account setup) was
  rejected by the URL sanitizer as a dotless host, so every such repository
  collapsed into "unknown" for both the workspace fallback and Claude Code
  sessions. The alias is now substituted from the ssh config before
  sanitizing; a repo under `\\wsl$` consults that WSL user's ssh config first.
- **A session whose `origin` was re-pointed mid-session resolves to the
  latest remote.** When a session carried more than one repo attribute value,
  the alphabetical `MAX()` pick could resolve it to the long-abandoned remote
  — hiding the repository the work actually landed in. The most recent
  repo-bearing span now wins.

## [0.9.8] - 2026-08-27

### Fixed

- **Phantom "unconnected" sessions no longer flood the Sessions tree.** The
  0.9.7 gate that admits conversation-only sessions (the autonomous Copilot CLI
  shape) also matched ordinary chat-helper telemetry — Next Edit Suggestions,
  commit-message/title/progress generators, and language-model wrappers — which
  emit conversation-keyed `chat` spans with no `chat_session_id`. Dozens of
  repo-less one-call "sessions" appeared as loose rows and inflated the totals.
  A conversation-only session must now also carry an agent-run span
  (`invoke_agent` / `execute_tool` / `execute_hook`), which every real
  autonomous run has and the helper noise never does.
- **Repositories with Copilot activity older than the 7-day live-ingest window
  no longer disappear.** With live updates on, the read layer used the
  live-OTLP ingest DB as its sole source, and that DB is pruned to 7 days — so
  every repository whose activity was older silently vanished from the tree.
  The durable home archive (180-day retention, continuously swept from the
  ingest DB) is now preferred whenever it exists. Live detail updates now
  refresh on the archive sweep cadence (default 60 s;
  `agentObservability.copilotArchive.sweepIntervalSeconds` goes down to 10 s),
  and overview/repository counts now cover the archive's full window.
- **`owner/repo` shorthand now works in `excludedRepositories` and the sync
  repository list.** Such an entry previously normalized to the literal
  `unknown`, so it hid the entire "no detected git remote" bucket instead of
  the intended repository. Shorthand now canonicalizes to
  `https://github.com/owner/repo`, and an unparseable entry is dropped instead
  of silently scoping the unknown bucket.
- **The workspace repository fallback matches session ids case-insensitively**,
  so sessions whose telemetry key differs from the stored (lowercased) id in
  casing are grouped under the workspace repo instead of "unknown".

### Added

- **Run time column in the agent tables.** The Main agent and Spawned
  sub-agents tables (session, combined, and repository views) show each
  agent's wall-clock run time — first to last observed model-turn activity
  within a session; combined and repository views sum the per-session times.

### Changed

- **Durations of a minute or longer render as hours/minutes/seconds** (for
  example `1h 30m 32s` instead of `5432.1 s`) in the session header, the
  combined view, and the timeline.

## [0.9.7] - 2026-07-28

### Fixed

- **"Copilot (Autonomous)" showed no sessions even after batches were pulled.**
  Relayed OTLP landed in the local sink correctly, but two read-layer assumptions
  borrowed from VS Code Copilot Chat hid every autonomous session:
  - The started-session gate required a UUID `chat_session_id`. An autonomous
    Copilot CLI run never emits one — the whole run shares a single
    `gen_ai.conversation.id` — so the Sessions tree and the repository rollup were
    empty while the Overview still counted the spans. Such a session is now
    admitted by its conversation id, but only when none of its spans carry a
    `chat_session_id`, which keeps Copilot Chat's per-turn conversation fragments
    (and spawned sub-agents) out of the list as before.
  - The repository was resolved only from `copilot_chat.repo.remote_url`.
    Autonomous agents report `github.copilot.git.repository` as a bare
    `owner/repo` slug, so every session resolved to `unknown` — and was therefore
    hidden entirely for anyone listing `unknown` in
    `agentObservability.excludedRepositories`. Both attribute spellings are now
    read (a full remote wins), with the slug normalized to
    `https://github.com/owner/repo` through the same privacy sanitizer.

## [0.9.6] - 2026-07-11

### Added

- **New source: "Copilot (Autonomous)".** Autonomous Copilot CLI agents (for
  example an Azure Container Apps job that remediates an alert) can push their
  full `gen_ai.*` OpenTelemetry to a cloud landing spot; when enabled, a
  background puller pulls those raw OTLP batches into a local sink under your
  home directory (`~/.agent-observability/copilot-agent/`) and shows the sessions
  alongside Copilot and Claude Code under a **Copilot (Autonomous)** node. Because
  the batches carry the same OTLP schema as local Copilot Chat, the session
  detail, context, and deviation panels light up unchanged. A single VS Code
  window pulls (elected via a lease); the rest follow its local sink. Off by
  default (opt-in). Configure with the new `agentObservability.copilotAgent.*`
  settings and authenticate the pull with a bearer token stored via the new
  **Copilot (Autonomous): Set relay token** command
  (`agentObservability.setAgentRelayToken`). The pulled data is stored locally and
  is **never re-uploaded** — it does not participate in the aggregate cloud-sync
  path.

## [0.9.5] - 2026-07-10

### Fixed

- **The "Total Overview" and "Main Agent" sections of the Context Analysis tab no
  longer disagree for single-agent sessions.** The Total Overview de-duplicated
  loaded files while the per-agent lists did not, so a file re-discovered across
  several turns (or two distinct skills that both use the `SKILL.md` filename)
  inflated the Main Agent file count and context-file token total above the Total
  — even when there were no sub-agents. Both views now collapse repeats using one
  shared file identity (the on-disk path when known, otherwise the name), so the
  same file is counted once while genuinely distinct skills are kept apart. As a
  result a session with only a main agent shows an identical Total and Main Agent.

## [0.9.4] - 2026-07-10

### Fixed

- **Session detail "Context Analysis" now lists the same customization files the
  Context Hotspots view attributes to that session.** The tab derived its loaded
  files only from Copilot's discovery `core_event` spans and `read_file` tool
  calls — but those discovery spans are never emitted on the live-updates capture
  stream, so files that reached the model purely via the system prompt's
  `<file>…</file>` list showed up under a file in Context Hotspots yet were absent
  (often "No context files detected") when you opened that session. The tab now
  reads the same system-prompt signal the Hotspots index uses, deduplicated
  against discovery/tool-read entries by path (and by name, except the shared
  `SKILL.md`, so distinct skills are kept apart), so the two views agree.

## [0.9.3] - 2026-07-08

### Fixed

- **Copilot (Cloud) credit usage now renders honestly for both billing units.**
  GitHub's agent-tasks API reports a per-session `usage.type`, and — mid-migration
  — mixes two units even under one account: legacy `ai_credits` (already in
  nano-credits) and the current `pru` (a small premium-request count). The panel
  previously divided **every** value by 1e9, so `pru` sessions (the large
  majority) showed `0.0000` credits and looked empty next to token data — the
  source of the "some sessions have tokens but no AI Credits" inconsistency. The
  mapper now reads the unit, scales each correctly, and the detail panel labels it
  accordingly ("Premium Requests" vs "AI Credits") so the two units never share a
  name or a scale.

## [0.9.2] - 2026-07-08

### Fixed

- **Copilot (Cloud) sessions no longer vanish when the agent-tasks API returns
  `repository` as an object `{ id }` instead of a bare number.** The repository
  id is now read from either shape, so tasks resolve to their real `owner/repo`
  instead of falling back to `unknown` — which the default
  `excludedRepositories: ["unknown"]` filter would then hide, making it look
  like there were no cloud sessions at all. Tasks that were already archived as
  `unknown` are re-resolved on the next poll (the finished-and-unchanged skip is
  bypassed while a task's repository is still `unknown`), so existing sessions
  reappear without a manual refresh.

## [0.9.1] - 2026-07-08

### Changed

- **Copilot (Cloud) polling is far gentler on the GitHub API to avoid secondary
  rate limits.** Each poll now (1) skips the task-detail request entirely for
  tasks the cheap list view already shows as finished and unchanged since they
  were fully archived, and (2) issues the remaining task-detail requests
  conditionally with an `ETag` / `If-None-Match`, so an unchanged task comes back
  as a `304 Not Modified` — which does not count against the primary rate limit —
  and the cached copy is reused. When GitHub does signal a rate limit, the poller
  now backs off for exactly as long as the `Retry-After` / `x-ratelimit-reset`
  header asks (clamped to a one-hour ceiling) instead of a fixed delay.

### Added

- **The output channel now logs which VS Code window owns Copilot (Cloud)
  polling**, and logs when a window takes over or steps down — mirroring the
  existing ownership logging for the live OTLP receiver. Only one window polls
  GitHub at a time (elected via a file lease); the rest follow its local sink.

## [0.9.0] - 2026-07-07

### Added

- **New "Copilot (Cloud)" source — GitHub Copilot cloud coding-agent sessions,
  right beside Copilot and Claude Code.** When enabled (off by default), the
  extension polls the GitHub agent-tasks API in the background — authenticated
  through the `gh` CLI or a per-account token — and materializes your cloud
  coding-agent tasks and sessions into a durable local sink under
  `~/.agent-observability/copilot-cloud/`. They then appear as their own
  top-level **Copilot (Cloud)** bucket in the Sessions tree (grouped by
  repository) and merge into the Local Overview, with session detail showing the
  prompt, lifecycle state (queued / in progress / waiting for user / failed /
  timed out), normalized model, branches, an "Open on GitHub" link, the tool
  timeline reconstructed from the session log, and AI-credit usage. One VS Code
  window polls at a time (elected via a file lease); the others follow the sink.
  Turn it on with `agentObservability.copilotCloud.enabled` and pin the accounts
  to poll with `agentObservability.copilotCloud.accounts` (the active `gh` login
  is captured automatically the first time you enable it).
- **New command "Copilot (Cloud): Set account token"** stores a per-account
  GitHub token (a `gh` OAuth token or a fine-grained PAT with the *Agent tasks*
  read permission) securely in VS Code SecretStorage — the escape hatch for
  accounts not signed into `gh`, machines without `gh`, or org policies that
  block `gh`'s OAuth app. The token is never echoed, logged, or uploaded.
- **The `@obs` chat participant now lists sessions from every source** (Copilot,
  Copilot Cloud, and Claude Code), routing each button to the right source.

### Changed

- Per-source presentation (cost basis + tree icon) is now declared on each source
  rather than inferred from its id, and a new **AI credits** cost basis is shown
  for cloud sessions (kept as its own unit — never converted to the AIU dollar
  rate). Copilot (Cloud) sessions are **local-only**: their prompts, tool I/O, and
  assistant text are pulled down and rendered on this machine but are never
  uploaded — the Sync view states this explicitly and shows each configured
  account's poll status.

## [0.8.0] - 2026-07-06

### Added

- **New "Context Hotspots" view — see which customization files your recent
  sessions actually used, and drill down to them.** The view lists the
  instruction, skill, prompt, agent, and hook files that appeared in your recent
  local sessions, busiest first, with a contributing-session count and an
  estimated token weight per file. Expand a file to see the individual sessions
  that had it in context and click one to open its local session detail — the
  on-machine companion to the organization dashboard's aggregate hotspots page,
  which cannot show session identities. Everything in this view is read locally
  and never leaves your machine.

### Fixed

- **Context-engineering hotspots now populate on the organization dashboard.**
  The aggregate that feeds the dashboard's Context Hotspots previously depended
  solely on customization "discovery" events, which the live telemetry stream the
  extension consumes never emits — so the page stayed empty. Context observations
  are now derived by fusing three signals the extension already captures: the
  system prompt's applied-file listing, `read_file` tool calls that target
  customization paths, and discovery events when present. As before, only
  repository-relative customization paths and counts are shared — never file
  contents, session identities, or any raw content.

## [0.7.0] - 2026-07-06

### Changed

- **A new chat now appears in the Sessions list right away — with the right
  repository — instead of after a delay.** Previously a session only showed up
  once it had emitted its first `user_request` span, which lands 7-33 seconds
  after the chat actually starts, and it sat under **unknown** until a later span
  happened to carry the repo URL. Three local-only changes close that gap:
  - **Surfaces at the first span.** The Sessions view now lists any started chat
    session (one that has emitted *any* span) rather than waiting for a
    `user_request`, so a session appears seconds sooner. Inline-suggestion-only
    sessions are still excluded, so the list is unchanged for those.
  - **Groups under the workspace repo immediately.** A just-started session with
    no repo attribute of its own is grouped under the current workspace's
    repository (resolved from its git remote), scoped to this workspace's own
    chat sessions so it can never mislabel activity from another window. Once the
    session's real repo span lands, that value takes over.
  - **Shows sessions that have no telemetry yet.** A chat that has been opened in
    this workspace but hasn't exported a single span is shown as a placeholder
    row (with its store title, under the workspace repo) and fills in with real
    metrics as soon as its first span arrives.
- **The Sessions list refreshes live when you open or continue a chat.** The
  extension now watches the current workspace's chat-session store and re-renders
  the list when a session is created or advances, so a new session pops in without
  a manual refresh. (Detail panels continue to update from the live span stream;
  the list refresh is deliberately driven only by the store to avoid flicker.)

All of the above reads only local, on-disk state; session titles and repository
names stay on your machine and are never added to the opt-in aggregate upload.

## [0.6.1] - 2026-07-03

### Added

- **The cloud "context-insights" upload is now visible in the log.** The
  dashboard's **Context Hotspots** page is fed by a separate, best-effort upload
  from your aggregate sync — and until now it produced no feedback, so an empty
  page was impossible to diagnose. Each sync that reaches this step now writes one
  content-free line to the **Agent Observability** output channel summarizing why
  nothing was sent or that a batch was uploaded: the reason
  (`no-context-source` / `no-rows-in-window` / `no-observations` / `error` /
  `sent`) plus counts for sessions considered, sessions with discovery events,
  indexed customization files, extracted observations, rows built, and the send
  outcome. This makes it clear when Context Hotspots stays empty because no
  in-repo customization files resolved (e.g. no discovery telemetry for the synced
  sessions, or no workspace open at sync time) versus a genuine send failure. The
  line carries only counts and a fixed reason code — never file paths, session
  keys, or any content.

## [0.6.0] - 2026-07-03

### Fixed

- **Live updates now work with multiple VS Code windows.** The live-OTLP port is
  a user-level setting shared by every window, so each window's receiver raced to
  bind it: the first won and every other window logged
  `EADDRINUSE: address already in use`, showed a misleading error toast, never
  attached the live ingest DB, and — worse — still opened the single-writer
  ingest store read-write. Windows now run a port election: the winner runs the
  receiver and writes the shared ingest DB; every other window follows it as a
  reader over a localhost `/events` stream (Server-Sent Events), refreshing on
  the receiver's persist-then-notify pings, and races to take the port over the
  moment the receiver's window closes — so live updates survive closing the
  original window. A window only opens the ingest store after winning the
  election. The error toast is reserved for genuine conflicts (a foreign process
  owning the port, or a receiver from a different VS Code profile), where
  re-running **Enable Live Updates** to pick a fresh port actually helps.
  Enabling/disabling live updates in one window now also re-arms the pipeline in
  every other window via the shared settings, instead of requiring a restart.
- **Copilot session names are back when reading from the durable archive.** The
  0.5.0 archive became the sole read source, but the title lookup only knew how
  to find the `workspaceStorage` title stores beside a NATIVE
  `github.copilot-chat` database — so every Copilot session lost its
  auto-generated name. Titles for archive- and live-ingest-sourced sessions are
  now resolved from the native candidate locations (all editions, whether or
  not the native telemetry DB still exists).
- **Session names now survive Copilot's rolling retention.** The archiver
  additionally copies each archived session's resolved title into a local-only
  `session_titles` sidecar table in the archive (only new/changed rows are
  written, an authoritative title is never downgraded to a first-request
  fallback, and titles are pruned with their sessions). The read layer layers
  live native titles over the archived ones, so renames still propagate while
  sessions older than the native stores' retention keep their names. Titles
  remain local-only — they are never uploaded.

### Added

- **Hide repositories from the whole extension.** The new
  `agentObservability.excludedRepositories` setting (empty by default,
  user-level) hides listed repositories everywhere: their sessions disappear
  from the Local Overview and Sessions views, and their aggregate rows are
  dropped upstream of cloud sync, the payload preview, and the repository
  pickers — regardless of the `sync.repositoryMode` scope. This is the local
  counterpart to the existing per-repository sync scoping. Entries are
  normalized through the same sanitizer as `sync.repositories` (so `org/repo`
  shorthand or a trailing `.git` still match) and the literal `unknown` hides
  sessions with no detected git remote. The new **Agent Observability: Choose
  Repositories to Hide** command (also on the Sessions view title bar) offers a
  checklist of the repositories found across both sources — checked = shown.
  Purely a read-time filter: local telemetry is untouched, so removing an entry
  (or re-checking it in the picker) brings the repository straight back, and
  un-hiding rewinds the sync watermark so the repository backfills on the next
  sync.

### Changed

- **Workflow `triggerPredicate` is now a pure applicability gate everywhere — it
  never filters interactions.** All workflow analysis is scoped to one
  user-request turn: a workflow applies to a turn when at least one of the turn's
  interactions matches the trigger, and every check (sequence, missing-step,
  timeout, tool-usage) then runs over the WHOLE turn. A trigger may therefore be
  narrower than — or disjoint from — its steps (e.g. trigger on a signature
  `toolName` while steps assert agents); the old "trigger must be a superset of
  every step" rule is gone, and the AI Helper's workflow-generation guidance no
  longer imposes it. The last session-scoped consumer (the sync path's
  context-insights deviation flagging) now buckets interactions into the same
  user-request turns as the session-detail view and the divergence notifier, and
  content-derived deviations are excluded from that flagging so raw local-only
  content can never influence what is uploaded.

## [0.5.0] - 2026-07-02

### Added

- **Durable, machine-wide Copilot session archive** (on by default). Copilot writes
  only a short, rolling `agent-traces.db` inside VS Code's per-edition
  `globalStorage`, so history is lost and sessions differ between windows. The
  extension now continuously sweeps Copilot's native database — across every
  discovered edition/environment (Stable, Insiders, WSL) plus the live-OTLP ingest
  DB — into a single durable archive under your home directory
  (`~/.agent-observability/copilot/agent-traces.db`), which the read layer prefers.
  Copilot sessions now persist long-term and appear in **every** VS Code window and
  edition on the machine — the way Claude Code sessions already do. Zero setup; runs
  in the background; a single-writer lease keeps one window authoritative; nothing is
  uploaded. Sessions Copilot rotated out before the archive first ran cannot be
  recovered. New settings: `agentObservability.copilotArchive.enabled` (default
  `true`), `.path`, `.retentionDays` (default `180`), and `.sweepIntervalSeconds`
  (default `60`).
- **Context Analysis tab for Claude Code sessions.** The tab (previously
  Copilot-only) now appears on Claude session-detail views. Because Claude emits no
  discovery telemetry, the loaded-context set is reconstructed from the transcript
  plus the on-disk `.claude` / CLAUDE.md tree: the always-in-context memory
  hierarchy (project `CLAUDE.md` up to the root + user `~/.claude/CLAUDE.md`),
  invoked skills and sub-agent definition files, and context-directory `Read` calls.
  The per-agent context-window bar uses the largest `input + cache_read +
  cache_creation` across each agent's turns. A caption notes the view is
  best-effort and reflects the current on-disk state. All analysis is LOCAL-ONLY.
- **AI Helper can now run on Claude Code.** A backend / model / effort selector row
  in the AI Helper chat lets you answer chats with either your GitHub Copilot
  license (default, unchanged) or the Claude Code CLI installed on this machine,
  under your own Anthropic login. Claude requests run locally via `claude -p` with
  all tools disabled and no session files written; streaming, cancellation, and the
  existing grounding + one-time-disclosure flow are preserved. New
  `application`-scoped settings (the dropdowns write them):
  `agentObservability.aiHelper.backend` (`copilot` | `claude-code`, default
  `copilot`), `.copilotModel`, `.claudeModel` (alias like `sonnet` or a full model
  id), `.claudeEffort`, and `.claudeCliPath`.
- **Repository detail view.** Repository rows in the Sessions tree get an inline
  hover button and context-menu entry — **Open Repository Details** — that opens a
  repository-level webview: the merged "Agent run totals" tiles plus the aggregated
  Main agent / Spawned sub-agents tables over EVERY session of that repository.
  Multi-selecting repository rows opens ONE combined view whose header lists each
  covered repository with its included-session count (a cross-source selection
  narrows to the first source, keeping one cost basis per card). Failed session
  loads and the per-source session cap are surfaced in the header, never dropped
  silently. Repository panels get the title-bar Refresh and live updates just like
  session panels.

### Changed

- **Live updates are now scoped to the open session-detail panel.** A live signal
  (a Copilot OTLP push or a Claude transcript write) re-renders the focused
  session-detail panel in near-real-time, but no longer refreshes the Sessions,
  Overview, or Sync trees on every poll — so the session list no longer flickers a
  loading state as the extension polls. Those trees still refresh on a manual
  refresh, a configuration change, and once when the live receiver first binds; the
  full session list does not need to be near-real-time. The proactive
  divergence-notifier scan still runs on the live path (it renders no loading UI and
  is off by default).
- **Live session-detail updates no longer reset the view.** A near-real-time update
  used to reassign the whole webview HTML, which reloaded the panel and collapsed
  every disclosure, reset the active tab, and jumped the scroll. The panel now mounts
  the document once and pushes only the new body as a message; an in-page controller
  swaps it in and restores open collapsibles, the active tab, and scroll — so a data
  push is seamless. (Manual refresh and accept-missing actions are preserved too.)
- **Proactive divergence notifications now cover every enabled source.** The
  notifier was bound to the Copilot telemetry service, so Claude Code sessions never
  produced divergence toasts. It now scans the settled user-request turns of recent
  sessions across all sources — including content-triggered workflows, whose prompt
  text stays LOCAL-ONLY and is read per source (Copilot from span attributes, Claude
  from the transcript). Settle/baseline/dedup behaviour is unchanged; dedup keys now
  include the source id so session ids from different sources can never collide.
- **`triggerContentPredicate` now works for Claude Code sessions.** Claude chat
  interactions carry a stable per-turn id and their governing user prompt, so
  prompt-content workflow triggers (e.g. a slash command in the request) gate Claude
  turns the same way as Copilot ones. Matched text is never stored on a deviation,
  and content-derived deviations remain excluded from sync.
- **Token totals now separate fresh input from cache reads — for both sources.**
  "Total Input Tokens" counts fresh (non-cache-read) input (Claude: uncached input +
  cache creation; Copilot: gross input minus cache reads), "Total Cached Input
  Tokens" counts cache reads only, and "Total Tokens" is input + cached + output —
  three disjoint buckets, so the total no longer double-counts cached input. Applies
  to the session-detail totals card, the per-model / per-agent tables, and combined
  views. Cloud aggregation is deliberately unchanged for now, so org-dashboard token
  numbers keep the old semantics and can differ from local views.
- **Session-detail panels are now titled.** The detail header and the editor tab
  show the session's LOCAL-ONLY title (the same one the Sessions list shows) instead
  of the short session id; the id stays visible in the header eyebrow. Untitled
  sessions keep the id.

### Fixed

- Workflows using `triggerContentPredicate` were flagged as invalid by VS Code's
  settings validation: the property was parsed and evaluated at runtime but missing
  from the extension's settings schema, so the `additionalProperties: false`
  workflow object rejected it. It is now declared in the schema.
- Cloud sync no longer fails a whole aggregate batch when source telemetry carries a
  human-facing model display name (e.g. `Claude Sonnet 4.5`, whose spaces fail the
  ingestion API's model-id pattern, causing the server to reject the entire batch).
  Model ids are sanitized to the contract's allowed character set on the cloud path
  only (blank or information-free values become `unknown`); local views keep the
  friendly model name.

## [0.4.0] - 2026-06-29

### Changed

- **Workflow deviation detection is now per user-request turn**, not per session.
  Each user request (and everything the agent spawned for it) is checked
  independently; `triggerPredicate` is now a pure applicability **gate** (it no
  longer filters the analyzed interactions), and a workflow's `steps` are verified
  as an ordered, not-necessarily-adjacent subsequence over the whole turn. The
  session-level "Workflow Deviations" overview is removed from the session-detail
  page; divergences now render inline on the offending request in the timeline.

### Added

- **Proactive divergence notifications** — `agentObservability.deviation.notifyOnDivergence`
  (off by default) raises a VS Code notification when a configured workflow diverges
  within a settled user-request turn, with an **Open session** action. Scans run on
  refresh; a silent baseline avoids notifying for pre-existing history.
- **`triggerContentPredicate`** — an optional LOCAL-ONLY content gate on a workflow,
  so relevance can key on the request's intent (e.g. `copilot_chat.user_request`
  contains a phrase) when no metadata signal distinguishes the task. Evaluated only
  on the local per-turn path; its deviations are flagged `contentDerived` and never
  participate in sync.
- **Real-time updates via a localhost OTLP receiver.** **Enable Live Updates (Copilot
  OTel)** now points Copilot's `otlp-http` exporter at a private `127.0.0.1` endpoint,
  ingests the pushed spans into the extension's OWN database (Copilot's exact schema),
  and refreshes the session views + per-turn divergence notifications live as an agent
  runs — no snapshot polling, no WAL lag. The extension becomes the telemetry sink;
  everything stays local (the receiver binds loopback only). Requires a **full VS Code
  restart** to switch Copilot's exporter (a window reload is not enough). New setting
  `agentObservability.liveUpdates.otelPort` (set automatically by the command).
- **Live updates now cover Claude Code too — via a transcript file watcher.** A shared
  live-update controller drives near-real-time refreshes from both sources behind a
  single debounce: Copilot's OTLP receiver and a new recursive watcher over Claude
  Code's `~/.claude/projects` JSONL transcripts. Because Claude writes those transcripts
  as a session runs, the Sessions/Overview views and the open session-detail panel now
  update live while a Claude Code agent works — with **no exporter setup and no VS Code
  restart** (unlike Copilot). **Enable Live Updates** now starts the Claude watcher
  immediately. A transcript event re-parses only the changed session (its mtime-keyed
  caches survive), so the live refresh stays cheap. Everything stays local; nothing is
  uploaded.
- **Per-repository cloud sync scope.** Cloud sync reads your merged local
  telemetry, which spans every repository you use Copilot in — not just the open
  workspace. Two new user-level settings now control which repositories'
  aggregates may be uploaded: `agentObservability.sync.repositoryMode`
  (`include` / `all` / `exclude`, default `include`) and
  `agentObservability.sync.repositories`. The default is privacy-first: `include`
  with an empty repository list uploads NOTHING until you pick at least one
  repository to share (set the mode to `all` to upload every repository). Both
  are `application`-scoped, so the
  policy lives in User settings and can't be silently overridden per-workspace.
  Filtering happens at the single point where the sync engine selects rows, so it
  scopes both the aggregate batch and the secondary context-insights batch.
- Command (category "Agent Observability"): **Choose Repositories to Sync** — a
  checklist of the repositories found in your local telemetry, pre-checked to the
  current scope, that writes the selection to User settings. Checking everything
  writes mode `all`; a subset writes `include`. Surfaced as a title-bar action on
  the Sync view and via a clickable **Sync scope** row showing how many
  repositories are eligible to upload.
- Changing the sync scope now rewinds the sync watermark so newly-included
  repositories backfill on the next run (re-sending is idempotent server-side).
- **Open Settings** is now a persistent gear action in the title bar of all views
  (Overview, Sessions, Sync, AI Helper), not just the empty-state welcome screens.

## [0.3.0] - 2026-06-26

### Added

- **AI Helper** — a chat webview in the Agent Observability activity-bar container,
  backed by the user's own GitHub Copilot license (`vscode.lm`) and grounded in
  baked-in context files. An empty chat offers quick-command buttons to **generate
  workflow definitions** from the project's Copilot customization files (instructions,
  agents, prompts, skills) — deriving the expected agents, their order, and tools from
  what the project declares, with the repository taken from the workspace git remote —
  **produce the minimal `.vscode/settings.json`** for a new project, and **summarize
  the collected logs**, plus free-text questions. Generated config can be copied or
  applied to workspace settings behind a confirmation (workflows are validated against
  the production parser and merged by repository).
- Commands `Agent Observability: Open AI Helper` and
  `Agent Observability: New AI Helper Chat`.
- A one-time disclosure gates the first AI Helper use; only safe metadata
  (sanitized repositories, agent/model/tool names, durations, token/AIU counts) and
  the user's prompt are sent to Copilot — never raw prompts/responses, tool I/O, or
  session titles, and never via the cloud-sync path. The **Generate workflows**
  command additionally sends the contents of the project's customization files (the
  user's own files, to the user's own Copilot license).
- **Near-real-time live updates** for the session-detail panel. When enabled, the
  extension tails the OpenTelemetry JSON-lines file written by GitHub Copilot
  Chat's `file` exporter and overlays a live status banner — current activity,
  turn, LLM calls, tool calls, tokens, sub-agents, and elapsed time — that
  refreshes within a fraction of a second as an agent runs. The file is read
  locally only; nothing is uploaded, and the durable session history continues to
  read the local SQLite database regardless of this feature.
- Commands (category "Agent Observability"): **Enable Live Updates (Copilot
  OTel)** and **Disable Live Updates**. Enabling configures Copilot's
  `github.copilot.chat.otel.enabled` / `exporterType` (`file`) / `outfile`
  settings to stream spans to a local file under the extension's global storage,
  flips the extension's own live-update settings on, and offers a window reload so
  Copilot picks up the exporter.
- Configuration: `agentObservability.liveUpdates.enabled` (OFF by default),
  `agentObservability.liveUpdates.otelFilePath` (blank = extension-managed
  default), and `agentObservability.liveUpdates.debounceMs` (min 100). Live
  updates add no overhead unless explicitly enabled.

## [0.2.0] - 2026-06-24

### Changed

- The cloud ingestion endpoint is now a built-in constant pointing at the
  organization dashboard, so aggregate uploads always target that dashboard and a
  workspace can no longer redirect the API key to an arbitrary host. Uploads
  remain gated on explicit consent and a stored organization API key.
- The **Sync** view now shows the built-in dashboard endpoint instead of a
  "not configured" placeholder.

### Removed

- The `agentObservability.dashboardUrl` setting — the ingestion endpoint is no
  longer user-configurable.

## [0.1.0] - 2026-06-02

### Added

- Initial extension scaffold (Phase 1 — shell only; no telemetry read, no
  SQLite, no network).
- Activity Bar container `agentObservability` ("Agent Observability") with three
  views: **Local Overview**, **Sessions**, and **Sync**.
- `viewsWelcome` placeholder content for each empty view.
- Commands (category "Agent Observability"): `refresh`, `syncNow`,
  `openSettings`, `setApiKey`, `toggleConsent`. Non-implemented commands show
  friendly "coming in a later phase" messages.
- `view/title` menu wiring: **Refresh** on Overview and Sessions; **Sync Now**
  on Sync.
- Configuration scaffold: `dashboardUrl`, `sync.enabled` (opt-out default),
  `sync.intervalMinutes` (min 5), `localTelemetry.enabled`, `sqlitePath`.
- Typed `Configuration` accessor, `TreeDataProvider` view providers with refresh
  seams, and a contract-stability smoke test (vitest).
- Build tooling: esbuild bundler, strict TypeScript, eslint, vitest.
