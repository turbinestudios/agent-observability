# Agent Observability

See what your AI coding agents actually did.

Agent Observability reads the sessions that **GitHub Copilot** and
**Claude Code** record on your computer and helps you look back at them:
what each session did, what it cost, where it went off track, and how to
improve the instructions you give your agents.

It runs on your machine and keeps your data there.

## What you can do with it

- **Browse your sessions.** Search, filter, tag, rename and take notes on every
  session from Copilot, the Copilot CLI and Claude Code in one list.
- **Follow a session turn by turn.** See tokens, tool calls and time for each
  turn, and spot the turn where the context got too big.
- **Compare sessions** side by side.
- **See what it cost.** Estimates for Claude from token prices, and for Copilot
  from premium usage.
- **Find what went wrong.** Sessions that ran too long or drifted from your
  workflow are flagged, and each session gets a short retrospective.
- **Improve your context files.** See which instruction files, skills and
  prompts your agents actually read, and get a suggested plan to improve them.
- **Ask questions** about your sessions in a built-in chat.

## Your data stays on your computer

- Your prompts, responses, tool input and output, file paths, names, branches
  and commits never leave your machine.
- **Team sharing is off by default.** If you turn it on, set your team's
  dashboard address and add an API key, only counts and totals are uploaded,
  under an anonymous id. The one exception is the repo-relative paths of your
  context files (such as `AGENTS.md` or a skill file), sent with their counts.
  The exact format is fixed in
  [schemas/aggregate-batch.schema.json](schemas/aggregate-batch.schema.json).
- **The Team view in the desktop app is also off by default and needs no
  server.** If you turn it on and pick a folder your team shares (OneDrive,
  SharePoint, a network drive), the app writes one file there with the same
  counts and totals under your anonymous id, plus how many sessions ran each
  day in each repository and how they went, and reads the files your teammates
  put there. You can preview the exact file before sharing. The format is
  fixed in [schemas/team-shard.schema.json](schemas/team-shard.schema.json).
- **Three optional AI features in the desktop app send content, and only when
  you ask.** They use your own Claude Code or GitHub Copilot CLI login, never a
  key of ours. Each one tells you exactly what it sends before it sends it:
  - **Deep Retrospective** (off by default): one session's summary, to write a
    retrospective.
  - **AI Helper:** your question, a summary of recent sessions, and parts of
    any session you attach.
  - **Context Improvement Plan** (off by default): usage figures, session
    findings and your context files, to suggest improvements.
- Applying an improvement plan only changes the context files you approve, one
  diff at a time, after taking a backup. It never deletes anything.

The full rules are in [docs/privacy-validation.md](docs/privacy-validation.md).

## The pieces

| Piece | What it is | Where |
| --- | --- | --- |
| **Desktop app** | The main app, for macOS and Windows. | [src/desktop](src/desktop/agent-observability-desktop) |
| **VS Code extension** | The same views inside VS Code. | [src/extension](src/extension/agent-observability-vscode) |
| **Team dashboard** | Optional. A web app that collects the totals your team chooses to share. | [src/dashboard](src/dashboard/AgentObservability.Dashboard) |

## Install

**Desktop app.** Download the installer for your system from
[Releases](https://github.com/turbinestudios/agent-observability/releases).

- macOS (Apple Silicon or Intel): open the `.dmg` and drag the app to
  Applications. The app is signed and notarized.
- Windows: run the `.exe`. The installer is not signed yet, so Windows
  SmartScreen may warn you. Choose **More info**, then **Run anyway**.

**VS Code extension.** Build the `.vsix` (see below) and install it with:

```bash
code --install-extension agent-observability-<version>.vsix
```

**Copilot users:** Copilot only saves sessions to disk when tracing is turned
on. The desktop app can turn it on for you in one click. In VS Code, set
`github.copilot.chat.otel.dbSpanExporter.enabled` to `true`.

**Claude Code users:** nothing to set up. Sessions are read from
`~/.claude/projects`.

More detail is in [docs/onboarding.md](docs/onboarding.md).

## Build from source

You need Node.js 22. The team dashboard also needs the .NET 10 SDK.

```bash
npm install                                    # once, from the repo root
npm run dev -w agent-observability-desktop     # run the desktop app
npm test --workspaces --if-present             # run all tests
```

To build the VS Code extension:

```bash
cd src/extension/agent-observability-vscode
npm run compile
npm run package    # writes the .vsix
```

To run the team dashboard locally (needs
[Azurite](https://learn.microsoft.com/azure/storage/common/storage-use-azurite)
for storage):

```bash
dotnet run --project src/dashboard/AgentObservability.Dashboard/AgentObservability.Dashboard.csproj
```

## Repo layout

| Folder | Contents |
| --- | --- |
| `src/core` | Shared logic: reading sessions, analysis, cost, upload. Used by both apps. |
| `src/desktop` | Desktop app (Electron and React). |
| `src/extension` | VS Code extension. |
| `src/dashboard` | Team dashboard (ASP.NET Core Blazor) and its tests. |
| `schemas` | The upload formats shared by the apps and the dashboard. |
| `infra` | Azure setup for the dashboard (Bicep). |
| `docs` | User, design and architecture docs. |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security problems privately, as
described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE).

Agent Observability is an independent project. It is not affiliated with or
endorsed by GitHub, Microsoft or Anthropic. GitHub Copilot and Claude Code are
trademarks of their owners.
