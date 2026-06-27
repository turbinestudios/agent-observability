# Changelog

All notable changes to the Agent Observability (Local) extension are documented
in this file. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Per-repository cloud sync scope.** Cloud sync reads your merged local
  telemetry, which spans every repository you use Copilot in — not just the open
  workspace. Two new user-level settings now control which repositories'
  aggregates may be uploaded: `agentObservability.sync.repositoryMode`
  (`all` / `include` / `exclude`, default `all` — unchanged behavior) and
  `agentObservability.sync.repositories`. Both are `application`-scoped, so the
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
- **Open Settings** is now a persistent gear action in the title bar of all three
  views (Overview, Sessions, Sync), not just the empty-state welcome screens.

## [0.3.0] - 2026-06-26

### Added

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
