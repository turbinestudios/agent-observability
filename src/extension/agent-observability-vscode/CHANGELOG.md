# Changelog

All notable changes to the Agent Observability (Local) extension are documented
in this file. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project adheres to [Semantic Versioning](https://semver.org/).

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
