# agent-observability

Azure-hosted agent observability platform for collecting Copilot OTLP telemetry, storing it in Azure Monitor, and surfacing operational insights through a Blazor dashboard.

## Dashboard

Phase 3 adds the Blazor Server dashboard at `src/dashboard/AgentObservability.Dashboard`.

### Local run

Set the workspace ID through configuration if you want live Azure Monitor data:

```powershell
$env:LogAnalytics__WorkspaceId = "<workspace-id>"
dotnet run --project src/dashboard/AgentObservability.Dashboard/AgentObservability.Dashboard.csproj
```

If no workspace ID is configured, the dashboard starts in demo mode with representative sample data so the UI remains usable during development.

### Container build

```powershell
docker build -t agent-observability-dashboard src/dashboard/AgentObservability.Dashboard
```