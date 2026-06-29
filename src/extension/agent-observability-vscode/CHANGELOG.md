# Changelog

All notable changes to the Agent Observability (Local) extension are documented
in this file. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
