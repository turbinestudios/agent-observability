# VS Code Copilot OTel Setup Scripts

Automate configuration of OpenTelemetry environment variables so that VS Code Copilot telemetry is tagged with `user.email` (per-developer) and `repo.name` (per-repository).

## How It Works

VS Code Copilot Chat exports traces, metrics, and events via OTLP. Two environment variables control auth and resource tagging:

| Variable | Purpose |
|----------|---------|
| `OTEL_EXPORTER_OTLP_HEADERS` | Auth header sent with every OTLP request |
| `OTEL_RESOURCE_ATTRIBUTES` | Key=value pairs attached to all telemetry |

These scripts split the resource attributes into two layers:

- **Global** (`OTEL_RESOURCE_ATTRIBUTES_GLOBAL`): set once per machine, contains `user.email=...`
- **Per-repo** (`.envrc.otel` / `.envrc.otel.ps1`): auto-sourced when you `cd` into a repo, composes the final `OTEL_RESOURCE_ATTRIBUTES` from the global piece + `repo.name=...`

## Run-Once vs. Run-Per-Repo

| Script | When to run | What it does |
|--------|-------------|--------------|
| `setup-global.sh` / `setup-global.ps1` | Once per developer machine | Sets `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_RESOURCE_ATTRIBUTES_GLOBAL` persistently |
| `setup-repo.sh` / `setup-repo.ps1` | Once per repository clone | Creates `.envrc.otel[.ps1]`, adds it to `.gitignore`, installs a shell hook to auto-source it |

## Quick Start

### macOS / Linux

```bash
# 1. Global setup (once per machine)
bash scripts/otel/setup-global.sh --email you@company.com --api-key "your-collector-api-key"

# 2. Per-repo setup (once per repo)
cd /path/to/your-repo
bash /path/to/agent-observability/scripts/otel/setup-repo.sh
```

### Windows (PowerShell)

```powershell
# 1. Global setup (once per machine)
.\scripts\otel\setup-global.ps1 -Email you@company.com -ApiKey "your-collector-api-key"

# 2. Per-repo setup (once per repo)
cd C:\path\to\your-repo
& C:\path\to\agent-observability\scripts\otel\setup-repo.ps1
```

## Verify It Worked

After restarting your terminal (and VS Code):

```bash
# macOS / Linux
echo $OTEL_EXPORTER_OTLP_HEADERS    # should show your auth header
echo $OTEL_RESOURCE_ATTRIBUTES       # should show user.email=...,repo.name=...
```

```powershell
# Windows PowerShell (inside the repo directory, after prompt fires)
$env:OTEL_EXPORTER_OTLP_HEADERS     # should show your auth header
$env:OTEL_RESOURCE_ATTRIBUTES       # should show user.email=...,repo.name=...
```

## Uninstall

Both scripts support an `--uninstall` flag that removes everything they wrote:

```bash
# macOS / Linux
bash scripts/otel/setup-global.sh --uninstall
bash scripts/otel/setup-repo.sh --uninstall
```

```powershell
# Windows
.\scripts\otel\setup-global.ps1 -Uninstall
.\scripts\otel\setup-repo.ps1 -Uninstall
```

This removes:
- The delimited blocks from your shell rc / PowerShell `$PROFILE`
- The `.envrc.otel` / `.envrc.otel.ps1` file from the repo root
- The User-scope environment variables (Windows)

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `OTEL_RESOURCE_ATTRIBUTES` is empty | Ensure you ran both the global and repo scripts, then restarted your terminal |
| Only `repo.name` shows, no `user.email` | The global script wasn't run or the terminal wasn't restarted after running it |
| Auth errors (401) from the collector | Verify `OTEL_EXPORTER_OTLP_HEADERS` is set correctly — run the global script again |
| Script says "not a git repository" | Run the repo script from within a git repository |
