# Onboarding a Repository to Agent Observability

This guide walks you through enabling OpenTelemetry telemetry export from VS Code Copilot to the Agent Observability platform.

## Prerequisites

- VS Code with GitHub Copilot extension installed
- Access to the Agent Observability platform (ask your platform team for the collector FQDN)

## Step 1: Configure VS Code OTLP Export

Add the following to your repository's `.vscode/settings.json`:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-http",
  "github.copilot.chat.otel.otlpEndpoint": "https://<COLLECTOR_FQDN>",
  "github.copilot.chat.otel.captureContent": true
}
```

Replace `<COLLECTOR_FQDN>` with the OTel Collector endpoint provided by your platform team.

> **Note:** Setting `captureContent` to `true` means full prompt and response content will be captured. This may include sensitive information — ensure your team is comfortable with this and that appropriate data retention policies are in place.

### Available Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `github.copilot.chat.otel.enabled` | Enable OpenTelemetry emission | `false` |
| `github.copilot.chat.otel.exporterType` | `otlp-http`, `otlp-grpc`, `console`, or `file` | `"otlp-http"` |
| `github.copilot.chat.otel.otlpEndpoint` | OTLP collector endpoint URL | `"http://localhost:4318"` |
| `github.copilot.chat.otel.outfile` | File path for JSON-lines output (file exporter) | `""` |
| `github.copilot.chat.otel.captureContent` | Capture full prompt/response content | `false` |

## Step 2: Add Repository Metadata

Create a `.github/copilot-observability.json` file in your repository root to tag telemetry with project metadata:

```json
{
  "repository": "my-org/my-repo",
  "team": "platform-team",
  "project": "my-project",
  "environment": "dev",
  "resourceAttributes": {
    "service.name": "my-repo",
    "deployment.environment": "dev"
  },
  "workflows": []
}
```

### Fields

| Field | Description | Required |
|-------|-------------|----------|
| `repository` | Full org/repo identifier | Yes |
| `team` | Team name for grouping | Yes |
| `project` | Project name | Yes |
| `environment` | Environment tag (`dev`, `staging`, `prod`) | Yes |
| `resourceAttributes` | OpenTelemetry resource attributes added to all spans | No |
| `workflows` | Expected workflow definitions for deviation detection (Phase 5) | No |

### Resource Attributes

The `resourceAttributes` field maps directly to OpenTelemetry resource attributes that will be attached to all telemetry from this repository. Key attributes:

- `service.name` — Identifies the repository in the dashboard
- `deployment.environment` — Environment classification (dev/staging/prod)
- Custom attributes can be added for additional grouping

## Step 3: Verify Telemetry Flow

1. Open your repository in VS Code
2. Start a Copilot chat session or use an agent
3. Wait 2–5 minutes for data to flow through the collector to Log Analytics
4. Open the Agent Observability dashboard and check the **Overview** page for your repository

### Troubleshooting

| Symptom | Possible Cause | Fix |
|---------|---------------|-----|
| No data in dashboard | OTLP export not enabled | Verify `.vscode/settings.json` is committed and VS Code reloaded |
| No data in dashboard | Incorrect endpoint | Verify `otlpEndpoint` matches the collector FQDN (include `https://`) |
| Partial data | Batch delay | Wait up to 5 minutes; the collector batches data before sending |
| Connection errors in VS Code | Collector unreachable | Check that the Container App is running and ingress is configured |

## Step 4: Commit and Share

Commit both files to your repository so all team members automatically export telemetry:

```bash
git add .vscode/settings.json .github/copilot-observability.json
git commit -m "feat: enable agent observability telemetry export"
git push
```

## Template Files

Pre-built templates are available in the `templates/` directory of the agent-observability repository:

- `templates/.vscode/settings.json` — VS Code settings template
- `templates/.github/copilot-observability.json` — Repository metadata template
