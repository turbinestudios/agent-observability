# Agent Observability — Agent Guide

Privacy-first agent observability for GitHub Copilot, built as a **split model**:
a local VS Code extension reads on-disk Copilot telemetry and keeps all raw
content on the machine, while a cloud dashboard serves org-level **aggregate-only**
analytics. See [README.md](README.md) for the full overview.

## Repository map

| Area | Path | Stack |
| --- | --- | --- |
| VS Code extension (producer) | [src/extension/agent-observability-vscode](src/extension/agent-observability-vscode) | TypeScript, esbuild, vitest |
| Cloud dashboard (consumer) | [src/dashboard/AgentObservability.Dashboard](src/dashboard/AgentObservability.Dashboard) | Blazor Server (.NET), xUnit |
| Shared aggregate contract | [schemas/aggregate-batch.schema.json](schemas/aggregate-batch.schema.json) | JSON Schema |
| Infrastructure | [infra](infra) | Bicep |
| Docs | [docs](docs) | Markdown |

## Build, test, run

**Extension** (run from `src/extension/agent-observability-vscode`):

```bash
npm install
npm run compile     # esbuild bundle to dist/extension.js
npm run typecheck   # tsc --noEmit (strict)
npm run lint        # eslint
npm test            # vitest run (headless)
npm run package     # vsce package (.vsix)
```

Press <kbd>F5</kbd> to launch an Extension Development Host. See the
[extension README](src/extension/agent-observability-vscode/README.md) for
architecture seams and the `node-sqlite3-wasm` packaging notes.

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
  (`src/extension/agent-observability-vscode/src/aggregate/*`,
  `.../src/sync/*`).
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
