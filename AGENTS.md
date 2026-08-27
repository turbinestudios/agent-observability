# Agent Observability — Agent Guide

Privacy-first agent observability for GitHub Copilot, built as a **split model**:
a local VS Code extension reads on-disk Copilot telemetry and keeps all raw
content on the machine, while a cloud dashboard serves org-level **aggregate-only**
analytics. See [README.md](README.md) for the full overview.

## Repository map

| Area | Path | Stack |
| --- | --- | --- |
| Shared core (host-independent) | [src/core/agent-observability-core](src/core/agent-observability-core) | TypeScript, vitest |
| VS Code extension (producer) | [src/extension/agent-observability-vscode](src/extension/agent-observability-vscode) | TypeScript, esbuild, vitest |
| Cloud dashboard (consumer) | [src/dashboard/AgentObservability.Dashboard](src/dashboard/AgentObservability.Dashboard) | Blazor Server (.NET), xUnit |
| Shared aggregate contract | [schemas/aggregate-batch.schema.json](schemas/aggregate-batch.schema.json) | JSON Schema |
| Infrastructure | [infra](infra) | Bicep |
| Docs | [docs](docs) | Markdown |

## Build, test, run

**Extension.** The repo is an npm workspace, so dependencies install once from
the **repo root** (they hoist to the root `node_modules`; there is a single root
`package-lock.json`):

```bash
npm install         # run at the repo root, installs every workspace
```

Build and test commands run from `src/extension/agent-observability-vscode`:

```bash
npm run compile     # esbuild bundle to dist/extension.js + stages node-sqlite3-wasm
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint
npm test            # vitest run (headless)
npm run package     # vsce package --no-dependencies (.vsix)
```

Or across all workspaces from the root: `npm run typecheck --workspaces
--if-present` (same for `lint`, `test`, `compile`).

`node-sqlite3-wasm` is external to the esbuild bundle and is staged into
`dist/node_modules` by `scripts/stageSqliteWasm.js` — workspace hoisting puts it
in the root `node_modules`, out of reach of `.vscodeignore`. Never re-add a
`!node_modules/**` re-include; verify packaging with `npx vsce ls
--no-dependencies` and check the `.wasm` sidecar is listed.

Press <kbd>F5</kbd> to launch an Extension Development Host. See the
[extension README](src/extension/agent-observability-vscode/README.md) for
architecture seams and the `node-sqlite3-wasm` packaging notes.

### Where code goes: core vs. extension

Most of the logic lives in **`src/core/agent-observability-core`** — session
sources and parsing, the telemetry/SQLite layer, aggregation, sync, deviation
and context analysis, the OTLP stack, and the pure HTML renderers. It is
host-independent: importing `vscode` there is a lint error, because the same
code is consumed by a standalone desktop app where that module does not exist.

The extension package keeps only what genuinely needs the VS Code API: the tree
views, the webview panel and chat provider, commands, `extension.ts` wiring, and
five small host adapters — `OutputChannelLogger`, `VscodeSettingsReader`,
`SecretManager`, `ConsentManager`, `GlobalStateSyncStateStore`, and
`vscodeFileWatchFactory`. When something needs a host capability, add an
interface in core and implement it here rather than reaching for `vscode`.

Core is consumed as TypeScript source and bundled in by esbuild, so there is no
build step and no `dist` to keep fresh; edit core and press F5. Cross-package
imports carry the `/src/` segment:

```ts
import { SessionSummary } from '@agent-observability/core/src/telemetry/models';
```

**Dashboard** (run from repo root):

```powershell
dotnet run  --project src/dashboard/AgentObservability.Dashboard/AgentObservability.Dashboard.csproj
dotnet test src/dashboard/AgentObservability.Dashboard.Tests/AgentObservability.Dashboard.Tests.csproj
```

CI deploys the dashboard and infra via [.github/workflows](.github/workflows);
the extension is not part of CI.

## Privacy invariant (do not break)

Raw content — prompts, completions, tool I/O, file paths, identities, branch and
commit names — **never leaves the machine**. The only thing uploaded is the
opt-in aggregate batch defined by
[schemas/aggregate-batch.schema.json](schemas/aggregate-batch.schema.json), which
is `additionalProperties: false` at every level.

- Never add a raw-content field to any aggregate / sync path
  (`src/core/agent-observability-core/src/aggregate/*`,
  `src/core/agent-observability-core/src/sync/*`).
- Cloud sharing is **off by default** and gated on explicit consent plus an API
  key in VS Code SecretStorage (never in `settings.json`).
- The dashboard ingestion URL is a hardcoded constant, not a user setting.

Before changing anything on the producer→consumer path, read
[docs/privacy-validation.md](docs/privacy-validation.md) and
[docs/architecture](docs/architecture), and keep the schema, the extension
aggregator, and the dashboard `AggregateBatchValidator` in sync.

## Changing the extension: bump version + update CHANGELOG

Any change to the extension code or manifest **must** bump the version in
[package.json](src/extension/agent-observability-vscode/package.json) and add a
matching entry to
[CHANGELOG.md](src/extension/agent-observability-vscode/CHANGELOG.md). The
detailed, enforced rule lives in
[.github/instructions/extension-versioning.instructions.md](.github/instructions/extension-versioning.instructions.md).
