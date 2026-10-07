# @agent-observability/core

The host-independent core of Agent Observability: everything that reads, parses,
analyzes, and renders agent sessions, with no dependency on any particular
application shell.

The [desktop app](../../desktop/agent-observability-desktop) consumes it. The
package is `private` and never published; it is consumed inside this repo
through npm workspaces.

## What lives here

| Area | Contents |
| --- | --- |
| `sources/` | `SessionDataSource` + `SourceRegistry`: the central abstraction every UI reads through |
| `telemetry/` | Copilot SQLite read layer, the shared session model (`models.ts`), snapshotting, titles, repository resolution |
| `claude/` | Claude Code JSONL discovery, parsing, and mapping to the shared model |
| `otel/` | The durable Copilot archive format (read by the desktop app), archive paths, writer-lease election |
| `aggregate/`, `context/`, `deviation/` | Aggregation and the privacy contract, context analysis, workflow deviation |
| `team/`, `consent/` | Team-shard building, validation and merging; consent disclosures |
| `views/`, `chat/` | Pure HTML renderers and the AI Helper's backend-agnostic seams |

## The one rule

**No host APIs.** Importing `vscode` here is an eslint error, and the same
applies to Electron: this package must load in a plain Node process.

When core needs something only a host can provide, it declares an interface and
the host implements it. The existing seams are `SettingsReader`,
`FileWatchFactory` and `CancellationToken`. Prefer extending one of those over inventing a new
abstraction.

The telemetry query layer also accepts `ReadonlySqliteConnection` and
`TelemetryReadBackend` from `telemetry/readBackend.ts`. The default is a WASM
snapshot reader. The desktop supplies native, read-only SQLite
transactions and indexed titles, while sharing all queries, validation, and
sanitization. Backend handles and derived caches are scoped to synchronous
`readConsistently` calls; they must not survive a transaction or pin WAL files
between requests. Core does not import the native driver.

Detail queries reuse compact model/mode maps and a single tree/write-delta entry
within that immutable read view. The write cache retains counts, not raw tool
arguments; its key includes the code/document extension classification. Session
sources optionally accept already-loaded detail for context labels and
retrospective scoring, avoiding a second detail reconstruction.

Large event timelines use escaped, inert JSON tuples and create at most 100
rows per open page through `textContent`. The nonce/CSP boundary is unchanged;
live updates restore the page alongside disclosure/tab/scroll state. The event
metadata is still in the document, and charts/prompts remain eager: this bounds
event DOM work, not all memory or payload size.

## Consuming it

There is no build step and no barrel file: the desktop app deep-imports the
TypeScript source and its bundler compiles it directly, with no `dist` to keep
in sync. Note the `/src/` segment, which is what makes the same specifier
resolve under tsc, vitest, and Vite:

```ts
import { SessionSummary } from '@agent-observability/core/src/telemetry/models';
```

## Tests

Tests are co-located with the code they cover and run headless by construction:

```bash
npm test -w @agent-observability/core
```

The lazy timeline tests use the dev-only jsdom dependency to exercise the real
controller, pagination, live updates, and hostile template content. Query reuse
tests assert work counts rather than machine-dependent elapsed time.

Some tests read fixtures from the repo root (`schemas/`, `tools/`) by relative
path, so keep this package's directory depth if it ever moves.
