# @agent-observability/core

The host-independent core of Agent Observability: everything that reads, parses,
analyzes, and renders agent sessions, with no dependency on any particular
application shell.

Two hosts consume it — the [VS Code extension](../../extension/agent-observability-vscode)
and the standalone desktop app — so a fix to session parsing or a new data source
lands in both at once. The package is `private` and never published; it is
consumed inside this repo through npm workspaces.

## What lives here

| Area | Contents |
| --- | --- |
| `sources/` | `SessionDataSource` + `SourceRegistry` — the central abstraction every UI reads through |
| `telemetry/` | Copilot SQLite read layer, the shared session model (`models.ts`), snapshotting, titles, repository resolution |
| `claude/` | Claude Code JSONL discovery, parsing, and mapping to the shared model |
| `cloud/`, `cloud-agent/` | Copilot Cloud and autonomous-agent sources with their local sinks |
| `otel/` | Local OTLP receiver, ingest store, archiver, writer-lease election |
| `aggregate/`, `context/`, `deviation/` | Aggregation and the privacy contract, context analysis, workflow deviation |
| `sync/`, `consent/` | The opt-in upload path, gated on consent plus an API key |
| `views/`, `chat/` | Pure HTML renderers and the AI Helper's backend-agnostic seams |

## The one rule

**No host APIs.** Importing `vscode` here is an eslint error, and the same
applies to Electron: this package must load in a plain Node process.

When core needs something only a host can provide, it declares an interface and
the host implements it. The existing seams are `Logger`, `SettingsReader`,
`FileWatchFactory`, `SyncStateStore`, `HttpPoster`, `Clock`, and
`CancellationToken` — prefer extending one of those over inventing a new
abstraction.

## Consuming it

There is no build step: `main` and `types` point at `src/index.ts`, and each
consumer's bundler compiles the TypeScript directly. Edit core and the extension
picks it up on its next build, with no `dist` to keep in sync.

`src/index.ts` re-exports the common entry points. Deep imports work too, and are
preferred in large consumers so imports stay traceable — note the `/src/` segment,
which is what makes the same specifier resolve under tsc, esbuild, vitest, and Vite:

```ts
import { TelemetryService } from '@agent-observability/core';
import { SessionSummary } from '@agent-observability/core/src/telemetry/models';
```

## Tests

Tests are co-located with the code they cover and run headless by construction:

```bash
npm test -w @agent-observability/core
```

Some tests read fixtures from the repo root (`schemas/`, `tools/`) by relative
path, which is why this package sits at the same directory depth as the
extension. Keep that depth if the package ever moves.
