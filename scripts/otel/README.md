# VS Code Copilot OTel Setup Scripts

Automate configuration of OpenTelemetry environment variables so that VS Code Copilot telemetry is authenticated and tagged with `user.email`.

## How It Works

VS Code Copilot Chat exports traces, metrics, and events via OTLP. Two environment variables control auth and resource tagging:

| Variable | Purpose |
|----------|---------|
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth header sent with every OTLP request |
| `OTEL_RESOURCE_ATTRIBUTES` | Key=value pairs attached to all telemetry |

The setup script (`setup-global.sh` / `setup-global.ps1`) is run **once per developer machine** and persistently sets:

- `OTEL_EXPORTER_OTLP_HEADERS` — Basic auth header formatted from your API key
- `OTEL_RESOURCE_ATTRIBUTES` — contains `user.email=<your-email>`

## Quick Start

### macOS / Linux

```bash
bash scripts/otel/setup-global.sh --email you@company.com --api-key "your-collector-api-key"
```

### Windows (PowerShell)

```powershell
.\scripts\otel\setup-global.ps1 -Email you@company.com -ApiKey "your-collector-api-key"
```

## Verify It Worked

After restarting your terminal and VS Code:

```bash
# macOS / Linux
echo $OTEL_EXPORTER_OTLP_HEADERS    # should show Authorization=Basic ...
echo $OTEL_RESOURCE_ATTRIBUTES       # should show user.email=you@company.com
```

```powershell
# Windows
[Environment]::GetEnvironmentVariable('OTEL_EXPORTER_OTLP_HEADERS', 'User')
[Environment]::GetEnvironmentVariable('OTEL_RESOURCE_ATTRIBUTES', 'User')
```

## Uninstall

```bash
# macOS / Linux
bash scripts/otel/setup-global.sh --uninstall
```

```powershell
# Windows
.\scripts\otel\setup-global.ps1 -Uninstall
```

This removes:
- The delimited block from your shell rc file (macOS/Linux)
- The User-scope environment variables (Windows)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `OTEL_RESOURCE_ATTRIBUTES` is empty | Run the setup script, then restart your terminal and VS Code |
| Auth errors (401) from the collector | Verify `OTEL_EXPORTER_OTLP_HEADERS` is set — run the script again with the correct API key |
