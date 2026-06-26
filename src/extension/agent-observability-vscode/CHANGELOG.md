# Changelog

All notable changes to the Agent Observability (Local) extension are documented
in this file. The format follows [Keep a Changelog](https://keepachangelog.com/)
and the project adheres to [Semantic Versioning](https://semver.org/).

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
