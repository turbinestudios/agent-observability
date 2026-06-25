# agent-observability

Privacy-first agent observability platform for GitHub Copilot. It uses a **split
model**: a **local VS Code extension** reads on-disk Copilot telemetry and keeps
all raw content on the developer's machine, while the **cloud dashboard** serves
**org-level aggregate analytics** from Azure Table Storage. Developers opt in to
upload **aggregate-only** batches to the dashboard's ingestion API.

> There is no OpenTelemetry collector and no raw Copilot telemetry in Azure
> Monitor in this model — that path is **retired**. (The legacy collector flow is
> archived for one release under [`docs/legacy/`](docs/legacy/).)

## Architecture (split model)

- **Local extension** (`src/extension/agent-observability-vscode`) —
  *Agent Observability (Local)*. Auto-reads the local Copilot `agent-traces.db`
  SQLite database **read-only**, shows local overview/sessions, and (opt-in,
  off by default) uploads **aggregate** batches to the dashboard. Raw prompts,
  responses, tool I/O, file paths, and identities never leave the machine.
- **Cloud dashboard** (`src/dashboard/AgentObservability.Dashboard`) — Blazor
  Server app that ingests aggregate batches (`POST /api/ingest/*`, authenticated
  by an org API key) and serves org-level aggregate analytics from Azure Table
  Storage. It has no raw session detail or raw KQL surface.
- **Shared contract** — [`schemas/aggregate-batch.schema.json`](schemas/aggregate-batch.schema.json),
  `additionalProperties:false`, is the single contract between the extension
  (producer) and the dashboard (consumer).
- **Infrastructure** (`infra/`) — Bicep (`main.bicep` + `modules/*`,
  `parameters.bicepparam`): Log Analytics (Container App logs), the dashboard
  Container App, ACR, Key Vault, and Storage. The OTel collector, App Insights,
  and AI Foundry are removed.

## Getting started

- **Developers:** [`docs/onboarding.md`](docs/onboarding.md) — install the
  extension, view local activity, optionally opt in to share aggregates.
- **Migrating off the legacy collector:** [`docs/migration.md`](docs/migration.md).
- **Privacy guarantee & enforcement:** [`docs/privacy-validation.md`](docs/privacy-validation.md).
- **Architecture & contracts:** [`docs/architecture/`](docs/architecture/).

## Dashboard

The Blazor Server dashboard lives at `src/dashboard/AgentObservability.Dashboard`.

### Local run

```powershell
dotnet run --project src/dashboard/AgentObservability.Dashboard/AgentObservability.Dashboard.csproj
```

Key configuration (appsettings-style; env via `__`): `Analytics` (`OrgId`),
`Ingestion` (`Enabled`, `KeyPepper`, `ApiKeys[]`), `Storage` (`TableEndpoint`).
The dashboard is aggregate-only — it serves analytics exclusively from the Azure
Table Storage aggregate store.

### Container build

```powershell
docker build -t agent-observability-dashboard src/dashboard/AgentObservability.Dashboard
```
