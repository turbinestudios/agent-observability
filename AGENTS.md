# Agent Observability: agent guide

A local tool for looking back at GitHub Copilot and Claude Code sessions. A
desktop app and a VS Code extension read the sessions the agents record on disk
and keep all raw content on the machine. The desktop app also reads GitHub
Copilot CLI sessions from `~/.copilot/session-state`, read-only: nothing in
this product writes or deletes under the Copilot CLI's own store. An optional team dashboard receives
only the totals a user chooses to share. See [README.md](README.md) for the
overview.

## Never commit or push

Do not run `git commit`, `git push`, `git tag`, `gh pr create`, or anything else
that writes to history or to GitHub, unless the user asks for it in that
message. Leave finished work in the working tree, say what changed, and let them
decide what gets committed and when.

Permission does not carry over: being told to commit once says nothing about the
next change. Everything else in git is fine unasked: reading history, `git
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
`dist/node_modules` by `scripts/stageSqliteWasm.js`, because workspace hoisting puts it
in the root `node_modules`, out of reach of `.vscodeignore`. Never re-add a
`!node_modules/**` re-include; verify packaging with `npx vsce ls
--no-dependencies` and check the `.wasm` sidecar is listed.

Press <kbd>F5</kbd> to launch an Extension Development Host. See the
extension's [DEVELOPMENT.md](src/extension/agent-observability-vscode/DEVELOPMENT.md)
for the code layout and the `node-sqlite3-wasm` packaging notes.

### Where code goes: core vs. extension

Most of the logic lives in **`src/core/agent-observability-core`**: session
sources and parsing, the telemetry/SQLite layer, aggregation, sync, deviation
and context analysis, the OTLP stack, and the pure HTML renderers. It is
host-independent: importing `vscode` there is a lint error, because the same
code is consumed by a standalone desktop app where that module does not exist.

The extension package keeps only what genuinely needs the VS Code API: the tree
views, the webview panel and chat provider, commands, `extension.ts` wiring, and
five small host adapters (`OutputChannelLogger`, `VscodeSettingsReader`,
`SecretManager`, `ConsentManager`, `GlobalStateSyncStateStore`, and
`vscodeFileWatchFactory`). When something needs a host capability, add an
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

[ci.yml](.github/workflows/ci.yml) runs typecheck, lint and tests for every
workspace on Windows and macOS, plus the dashboard tests, on every pull request
and push to `main`. The deploy workflows publish the dashboard and infra. They
run only when started by hand, and in the `production` environment. The
dashboard is not deployed for now, so do not add a `push:` trigger back.

## Tests must not depend on the machine that runs them

A green local run proves nothing about CI, and this has now broken a desktop
release twice: once on a slow runner overrunning vitest's 5s default, once on
a US-locale runner formatting a date as `Aug 7` where the author's machine
said `7 Aug`. The release workflow is triggered **by the tag**
([release-desktop.yml](.github/workflows/release-desktop.yml)), so the tests
run *after* the version is tagged. A failure there means a tagged version
with no installers, recoverable only by another version bump.

Never assert on a value the environment chooses:

- **Locale.** `toLocaleDateString`, `toLocaleTimeString`, `toLocaleString`,
  anything `Intl`. The runner is `en-US`; a European dev machine is not.
  Compute the expectation by calling the same formatter, and assert the logic
  *around* it (that a range joins two names, that a prefix is added) rather
  than what `Intl` chose to return. `formatCost` shows the other way out: when
  a figure must read identically everywhere, format it by hand and say so.
- **Timezone.** Build fixture dates with `new Date(y, m, d)` and compare
  against values derived the same way; never mix in a UTC literal or
  `toISOString`, which shifts the day either side of Greenwich.
- **Clock speed.** Anything that copies a SQLite fixture or walks a real tree
  needs a `testTimeout` that fits a loaded runner, not a fast laptop. Never
  assert on elapsed time.
- **Platform.** Path separators, path case, and line endings all differ
  between the Windows and macOS runners the release matrix uses. Compare with
  `path.join`/`path.sep`, never a hard-coded `/` or `\`.

The question to ask of every new assertion: *would this still be true on a
different machine, in a different country, in December?* If the answer depends
on the answer to "whose machine?", the assertion is wrong, not the runner.

## Privacy invariant (do not break)

Raw content (prompts, completions, tool I/O, file paths, identities, branch and
commit names) **never leaves the machine**. The only things that do are two
opt-in, schema-bound aggregate artifacts: the **aggregate batch** (with its
companion **context-insights batch**) that the VS Code extension uploads to
the dashboard, defined by
[schemas/aggregate-batch.schema.json](schemas/aggregate-batch.schema.json) and
[schemas/context-insights-batch.schema.json](schemas/context-insights-batch.schema.json);
and the desktop app's **team shard**, a JSON file written to a folder the user
chose, defined by
[schemas/team-shard.schema.json](schemas/team-shard.schema.json), which embeds
those same two batches unchanged plus per-day session-outcome counts
(sessions, verdict mix, estimated cost) by repository and source. All three
schemas are `additionalProperties: false` at every level.

- Never add a raw-content field to any aggregate / sync / team path
  (`src/core/agent-observability-core/src/aggregate/*`,
  `src/core/agent-observability-core/src/sync/*`,
  `src/core/agent-observability-core/src/team/*`,
  `src/desktop/agent-observability-desktop/src/datahost/team/*`). The team
  shard may only embed the two batch schemas by `$ref`, never copy or extend
  them; update the TypeScript validators in `aggregate/batchValidators.ts` in
  the same change as the C# ones.
- The Team view in the desktop app is **off by default** (`team.enabled`);
  while it is off the team folder is neither read nor written. Team sharing
  is a second switch, also **off by default**, gated on a disclosure
  dialog that lists the repositories involved and records when consent was
  given, writes only to the folder the user picked, and offers a byte-exact
  preview of the file first. Reading the folder is on while Team is, and is
  read-only:
  every shard is validated against the schema before merging, and anything
  that fails is skipped with a visible notice. The per-install salt behind the
  anonymous id lives in its own file, never in `config.json`, never in a shard.
- Cloud sharing is **off by default** and gated on explicit consent plus an API
  key in VS Code SecretStorage (never in `settings.json`).
- The dashboard address (`agentObservability.sync.dashboardUrl`) is an
  `application`-scoped setting, so only the user's own settings can set it and
  a workspace can never redirect the API key. Only `https://` addresses are
  accepted; anything else counts as unset and blocks sync.
- **Three sanctioned exceptions**, all desktop-only and all strictly the
  user's **own local AI CLI login**: Claude Code (`claude`, sends to
  Anthropic) or the GitHub Copilot CLI (`copilot`, sends to GitHub),
  whichever backend the user selects in Settings; their account, never a
  product API key. They are only ever user-initiated, never in the background,
  and never on the aggregate/sync path, which continues to carry no raw
  content, ever:
  1. The **Deep Retrospective**: when the user turns it on in Settings (off by
     default) *and* confirms a per-session dialog stating exactly what is
     sent and to which vendor, that one session's transcript digest goes to
     that vendor to write a retrospective.
  2. The **AI Helper**: after a one-time first-use notice in the view stating
     exactly what each message carries (the user's question, a summary of
     recent sessions with titles, repositories, verdicts, token and cost
     figures, and, when the user attaches a session, capped excerpts of its
     prompts and responses), each explicit send in the chat goes to the
     selected vendor the same way.
  3. The **Context Improvement Plan**: when the user turns it on in Settings
     (off by default) *and* confirms a per-generation dialog naming the
     vendor and exactly what is sent (the selected context files' usage
     statistics, the selected sessions' retrospective evidence with titles and
     goals included, and the repository's context-file contents, capped),
     that payload goes to the selected vendor to write an improvement plan
     for the repository's context files.

  Nothing else may cite these exceptions as precedent.

- **The app as agent host (Run).** When the user turns Run on in Settings
  (off by default) and has acknowledged a one-time notice in the view, the
  desktop app can start and continue GitHub Copilot sessions through the
  Copilot SDK, driving the user's **own installed, unmodified `copilot`**
  under their **own Copilot login**; never a product API key, never a
  bundled runtime. A hosted session sends the user's message, and whatever
  repository content the agent then reads, to GitHub, exactly as running
  `copilot` in that directory does. The rules:
  1. **User-initiated per message.** Nothing is sent until the user
     presses Start or Send. Doors from other views only prefill an
     editable goal box; the text in the box is exactly what is sent.
  2. **Ask is the only permission posture.** Every permission request is
     shown to the user and waits for their answer: allow once, allow for
     this session, or deny. The app never answers on the user's behalf,
     never passes `--allow-all` or an equivalent, never persists an
     approval beyond the session, and strips permission-widening
     environment variables.
  3. **Never in the background.** No scheduled, automatic or hidden
     session; none starts at launch; closing the app stops hosting.
  4. **Separate from sharing.** Nothing from a hosted session enters the
     aggregate, sync or team paths other than the counts every indexed
     session contributes. The run host has no import from `aggregate/*`,
     `sync/*` or `team/*`.
  5. **Claude Code is never driven.** The app only opens the user's own
     terminal with their own `claude --resume <id>`; it does not use the
     Claude Agent SDK and does not spawn `claude` to run a session.

  This clause is not one of the sanctioned exceptions and none of them may
  be cited to widen it.

- **One sanctioned local write path.** Applying a Context Improvement Plan may
  write **only** allowlisted context files (`CLAUDE.md`, `AGENTS.md`,
  `copilot-instructions.md`, `SKILL.md`, `*.instructions.md`, `*.prompt.md`,
  `*.agent.md`, `*.skill.md`) inside the plan's re-verified repository root,
  with each file approved individually after a diff preview, refused when the file
  changed since the plan was generated, backed up before the first byte is
  written, and never deleting anything. No other **app** code may write into a
  user's repository. An agent the user hosts through Run writes only through
  the Copilot CLI's own tools, each write approved by the user under the
  clause above.

Before changing anything on the producer→consumer path, read
[docs/privacy-validation.md](docs/privacy-validation.md) and
[docs/architecture](docs/architecture), and keep the schemas, the extension
aggregator, the dashboard `AggregateBatchValidator`, and core's
`aggregate/batchValidators.ts` / `team/teamShardValidator.ts` in sync.

## Changelogs: user-facing change only

Both shipped products keep a changelog, and both are read by the people who use
them rather than by reviewers:

| Product | File | Where users read it |
| --- | --- | --- |
| Desktop app | [CHANGELOG.md](src/desktop/agent-observability-desktop/CHANGELOG.md) | The **What's new** dialog, opened from the sparkle at the bottom of the sidebar |
| VS Code extension | [CHANGELOG.md](src/extension/agent-observability-vscode/CHANGELOG.md) | The Marketplace listing |

**Add an entry when, and only when, a user can see or do something differently
because of the change.** A new capability, changed behaviour, a bug they could
actually hit, a speed-up they would notice: those earn an entry. Internal work
earns none, however large: refactors, test coverage, build and CI changes,
comments, documentation, dependency bumps that change nothing observable.

When a change qualifies, in the same commit as the change itself:

1. **Bump `version`** in that package's `package.json`, following SemVer.
2. **Insert `## [x.y.z] - YYYY-MM-DD`** at the top of that package's
   `CHANGELOG.md`, above the previous version, using today's date and the exact
   version you set.
3. **Group the notes** under `### Added`, `### Changed`, `### Fixed`,
   `### Removed`. Omit a heading with nothing under it.
4. **Write it for the person using the app**: what changed and why it matters to
   them. Not a diff summary, and never a file, class or function name. If an
   entry cannot be written without naming internals, that is the signal it was
   not a user-facing change.

The desktop changelog is parsed and rendered by the app itself
([parseChangelog.ts](src/desktop/agent-observability-desktop/src/renderer/src/changelog/parseChangelog.ts)),
so it has to stay in that exact shape (`## [version] - date`, `### Group`,
`- item`), with `**bold**`, `` `code` `` and `[links](url)` as the only inline
markup. Its tests parse the real file, so a malformed entry fails the build
rather than reaching a user as an empty dialog.

## Changing the extension: bump version + update CHANGELOG

Any change to the extension code or manifest **must** bump the version in
[package.json](src/extension/agent-observability-vscode/package.json) and add a
matching entry to
[CHANGELOG.md](src/extension/agent-observability-vscode/CHANGELOG.md). The
detailed, enforced rule lives in
[.github/instructions/extension-versioning.instructions.md](.github/instructions/extension-versioning.instructions.md).
