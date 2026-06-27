# Settings reference (`agentObservability.*`)

All keys are written flat under the `agentObservability.` prefix in `.vscode/settings.json`.

| Key | Type | Default | Meaning |
| --- | --- | --- | --- |
| `agentObservability.localTelemetry.enabled` | boolean | `true` | Enable reading the local Copilot telemetry DB. When false the extension reads nothing. |
| `agentObservability.sqlitePath` | string | `""` | Override the path to Copilot's `agent-traces.db`. Leave blank to auto-detect (merges every reachable DB across Windows + WSL). Set it only to pin a single database. |
| `agentObservability.sync.enabled` | boolean | `false` | Opt in to upload aggregated, non-sensitive stats to the org dashboard. Off by default. |
| `agentObservability.sync.intervalMinutes` | number | `60` | Background sync interval, minutes (minimum 5). |
| `agentObservability.deviation.maxSessionMinutes` | number | `60` | Max expected agent-session duration; longer sessions are flagged (TimeoutExceeded) when no explicit workflow applies. |
| `agentObservability.workflows` | array | `[]` | Per-repository expected workflows for the local deviation detector. See the workflow DSL reference. |
| `agentObservability.context.acceptedMissingFiles` | string[] | `[]` | Context file names accepted as missing (hidden from "Expected but missing"). |
| `agentObservability.context.acceptedMissingSources` | string[] | `[]` | Source file names whose outgoing missing references are suppressed. |
| `agentObservability.analysis.codeFileExtensions` | string[] | (common code exts) | Extensions counted as source code for the LoC metric. |
| `agentObservability.analysis.docFileExtensions` | string[] | (`.md`, `.rst`, …) | Extensions counted as documentation for the LoD metric. |

## Not a setting
- The **organization API key** is a secret, NOT a setting. It is stored in VS Code SecretStorage and
  set via the command **"Agent Observability: Set Organization API Key"**
  (`agentObservability.setApiKey`). Never put an API key in `settings.json`.
- The dashboard ingestion URL is built in and not user-configurable.
