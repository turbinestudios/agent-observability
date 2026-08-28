# Agent Observability — Agent Guide

Privacy-first agent observability for GitHub Copilot, built as a **split model**:
a local VS Code extension reads on-disk Copilot telemetry and keeps all raw
content on the machine, while a cloud dashboard serves org-level **aggregate-only**
analytics. See [README.md](README.md) for the full overview.

## Never commit or push

Do not run `git commit`, `git push`, `git tag`, `gh pr create`, or anything else
that writes to history or to GitHub — unless the user asks for it in that
message. Leave finished work in the working tree, say what changed, and let them
decide what gets committed and when.

Permission does not carry over: being told to commit once says nothing about the
next change. Everything else in git is fine unasked — reading history, `git
status`, `git diff`, creating a branch to work on, staging.

## Repository map

| Area | Path | Stack |
| --- | --- | --- |
| Shared core (host-independent) | [src/core/agent-observability-core](src/core/agent-observability-core) | TypeScript, vitest |
| VS Code extension (producer) | [src/extension/agent-observability-vscode](src/extension/agent-observability-vscode) | TypeScript, esbuild, vitest |
| Desktop app | [src/desktop/agent-observability-desktop](src/desktop/agent-observability-desktop) | Electron, React, vitest |
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
- **Two sanctioned exceptions**, both desktop-only and both strictly the
  user's **own local `claude` CLI login** (their account, never a product API
  key), only ever user-initiated, never in the background, and never on the
  aggregate/sync path — which continues to carry no raw content, ever:
  1. The **Deep Retrospective**: when the user turns it on in Settings (off by
     default) *and* confirms a per-session dialog stating exactly what is
     sent, that one session's transcript digest goes to Anthropic to write a
     retrospective.
  2. The **AI Helper**: after a one-time first-use notice in the view stating
     exactly what each message carries — the user's question, a summary of
     recent sessions (titles, repositories, verdicts, token and cost
     figures), and, when the user attaches a session, capped excerpts of its
     prompts and responses — each explicit send in the chat goes to Anthropic
     the same way.

  Nothing else may cite these exceptions as precedent.

Before changing anything on the producer→consumer path, read
[docs/privacy-validation.md](docs/privacy-validation.md) and
[docs/architecture](docs/architecture), and keep the schema, the extension
aggregator, and the dashboard `AggregateBatchValidator` in sync.

## Changelogs: user-facing change only

Both shipped products keep a changelog, and both are read by the people who use
them rather than by reviewers:

| Product | File | Where users read it |
| --- | --- | --- |
| Desktop app | [CHANGELOG.md](src/desktop/agent-observability-desktop/CHANGELOG.md) | The **What's new** dialog, opened from the sparkle at the bottom of the sidebar |
| VS Code extension | [CHANGELOG.md](src/extension/agent-observability-vscode/CHANGELOG.md) | The Marketplace listing |

**Add an entry when, and only when, a user can see or do something differently
because of the change.** A new capability, changed behaviour, a bug they could
actually hit, a speed-up they would notice — those earn an entry. Internal work
earns none, however large: refactors, test coverage, build and CI changes,
comments, documentation, dependency bumps that change nothing observable.

When a change qualifies, in the same commit as the change itself:

1. **Bump `version`** in that package's `package.json`, following SemVer.
2. **Insert `## [x.y.z] - YYYY-MM-DD`** at the top of that package's
   `CHANGELOG.md`, above the previous version, using today's date and the exact
   version you set.
3. **Group the notes** under `### Added`, `### Changed`, `### Fixed`,
   `### Removed`. Omit a heading with nothing under it.
4. **Write it for the person using the app** — what changed and why it matters to
   them. Not a diff summary, and never a file, class or function name. If an
   entry cannot be written without naming internals, that is the signal it was
   not a user-facing change.

The desktop changelog is parsed and rendered by the app itself
([parseChangelog.ts](src/desktop/agent-observability-desktop/src/renderer/src/changelog/parseChangelog.ts)),
so it has to stay in that exact shape — `## [version] - date`, `### Group`,
`- item` — with `**bold**`, `` `code` `` and `[links](url)` as the only inline
markup. Its tests parse the real file, so a malformed entry fails the build
rather than reaching a user as an empty dialog.

## Changing the extension: bump version + update CHANGELOG

Any change to the extension code or manifest **must** bump the version in
[package.json](src/extension/agent-observability-vscode/package.json) and add a
matching entry to
[CHANGELOG.md](src/extension/agent-observability-vscode/CHANGELOG.md). The
detailed, enforced rule lives in
[.github/instructions/extension-versioning.instructions.md](.github/instructions/extension-versioning.instructions.md).
