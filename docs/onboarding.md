# Onboarding a Repository to Agent Observability

This guide walks you through enabling OpenTelemetry telemetry export from VS Code Copilot to the Agent Observability platform.

## Prerequisites

- VS Code with GitHub Copilot extension installed
- Access to the Agent Observability platform (ask your platform team for the collector FQDN and API key)

## Step 1: Set Up Authentication (User Environment Variable)

The OTLP endpoint requires HTTP Basic Authentication. Set this as a **user-level environment variable** on your machine so it persists across all repositories and VS Code sessions.

### Windows

Set via System Properties > Environment Variables > User variables, or run in an elevated PowerShell:

```powershell
[Environment]::SetEnvironmentVariable(
  "OTEL_EXPORTER_OTLP_HEADERS",
  "Authorization=Basic $([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('otlp:<YOUR_API_KEY>')))",
  "User"
)
```

Restart VS Code after setting the variable.

### macOS / Linux

Add to your shell profile (`~/.bashrc`, `~/.zshrc`, etc.):

```bash
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic $(echo -n 'otlp:<YOUR_API_KEY>' | base64)"
```

Then reload your shell or restart VS Code.

> **Security note:** Do not commit API keys to version control. The auth header lives only in your local environment variable, never in repository files.

## Step 2: Configure VS Code OTLP Export

Add the following to your repository's `.vscode/settings.json`:

```json
{
  "github.copilot.chat.otel.enabled": true,
  "github.copilot.chat.otel.exporterType": "otlp-http",
  "github.copilot.chat.otel.otlpEndpoint": "https://<COLLECTOR_FQDN>",
  "github.copilot.chat.otel.captureContent": true,
  "github.copilot.chat.otel.otlpHeaders": {
    "x-repository": "<org>/<repo-name>",
    "x-team": "<team-name>",
    "x-project": "<project-name>",
    "x-environment": "dev",
    "x-service-name": "<repo-name>"
  }
}
```

Replace `<COLLECTOR_FQDN>` with the OTel Collector endpoint provided by your platform team.

### Header Fields

| Header | Description |
|--------|-------------|
| `x-repository` | Full org/repo identifier (e.g., `my-org/my-repo`) |
| `x-team` | Team name for grouping in the dashboard |
| `x-project` | Project name |
| `x-environment` | Environment tag (`dev`, `staging`, `prod`) |
| `x-service-name` | Identifies the repository in the dashboard (maps to `service.name`) |

These headers are sent with every OTLP request and extracted into resource attributes by the collector.

> **Note:** Setting `captureContent` to `true` means full prompt and response content will be captured. This may include sensitive information — ensure your team is comfortable with this and that appropriate data retention policies are in place.

### Available Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `github.copilot.chat.otel.enabled` | Enable OpenTelemetry emission | `false` |
| `github.copilot.chat.otel.exporterType` | `otlp-http`, `otlp-grpc`, `console`, or `file` | `"otlp-http"` |
| `github.copilot.chat.otel.otlpEndpoint` | OTLP collector endpoint URL | `"http://localhost:4318"` |
| `github.copilot.chat.otel.outfile` | File path for JSON-lines output (file exporter) | `""` |
| `github.copilot.chat.otel.captureContent` | Capture full prompt/response content | `false` |
| `github.copilot.chat.otel.otlpHeaders` | Custom headers sent with every OTLP request | `{}` |

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
| 401 Unauthorized | Missing or invalid auth header | Verify `OTEL_EXPORTER_OTLP_HEADERS` env var is set and VS Code was restarted |
| Partial data | Batch delay | Wait up to 5 minutes; the collector batches data before sending |
| Connection errors in VS Code | Collector unreachable | Check that the Container App is running and ingress is configured |

## Step 4: Commit and Share

Commit the settings file to your repository so all team members automatically export telemetry:

```bash
git add .vscode/settings.json
git commit -m "feat: enable agent observability telemetry export"
git push
```

Each developer still needs to set the `OTEL_EXPORTER_OTLP_HEADERS` environment variable locally (Step 1).

## Template Files

Pre-built templates are available in the `templates/` directory of the agent-observability repository:

- `templates/.vscode/settings.json` — VS Code settings template with OTLP headers
