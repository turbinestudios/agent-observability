# Minimal configuration for a new project

The extension works **out of the box** with no configuration:
- `agentObservability.localTelemetry.enabled` defaults to `true`.
- `agentObservability.sqlitePath` defaults to blank, which auto-detects Copilot's `agent-traces.db`
  (merging every reachable database across Windows and WSL).

So the truly minimal `.vscode/settings.json` is often empty for local use. Only add keys when the
defaults don't fit. Emit a JSON **object** (the contents of `.vscode/settings.json`) in a single
fenced ` ```ao-config ` block.

## Common minimal setups

Local viewing only (explicit, equals the defaults):
```ao-config
{
  "agentObservability.localTelemetry.enabled": true
}
```

Pin a specific database (only when auto-detect picks the wrong one):
```ao-config
{
  "agentObservability.sqlitePath": "C:\\\\Users\\\\me\\\\AppData\\\\Roaming\\\\Code\\\\User\\\\globalStorage\\\\github.copilot-chat\\\\agent-traces.db"
}
```

Enable opt-in cloud sharing (statistics only):
```ao-config
{
  "agentObservability.sync.enabled": true
}
```

## Remember
- Do NOT put an API key in settings. After enabling sync, tell the user to run the command
  **"Agent Observability: Set Organization API Key"** — the key is stored in SecretStorage.
- Only emit keys from the settings reference; never invent keys.
