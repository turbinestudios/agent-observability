# Getting started

Agent Observability reads the sessions your AI coding agents record on your
computer and lets you look back at them. You can use the desktop app, the VS
Code extension, or both. They read the same data.

Everything in steps 1 to 3 stays on your computer. Step 4, team sharing, is
optional and off by default.

## Step 1: Install

**Desktop app (recommended).** Download the installer for your system from
[Releases](https://github.com/turbinestudios/agent-observability/releases).

- **macOS:** open the `.dmg` and drag the app to Applications. There are builds
  for Apple Silicon (`arm64`) and Intel (`x64`). The app is signed and
  notarized.
- **Windows:** run the `.exe`. The installer is not signed yet, so SmartScreen
  may warn you. Choose **More info**, then **Run anyway**.

The app checks for updates when it starts and always asks before downloading.

**VS Code extension.** Build the `.vsix` as described in the
[README](../README.md#build-from-source), then install it:

```bash
code --install-extension agent-observability-<version>.vsix
```

Open **Agent Observability** in the Activity Bar. It has five views:
**Local Overview**, **Sessions**, **Sync**, **Context Hotspots** and
**AI Helper**.

## Step 2: Make sure your agent is recording

**Claude Code** always saves its sessions under `~/.claude/projects`. There is
nothing to set up.

**GitHub Copilot** only saves sessions while one setting is on, and it is off
by default. Without it there is nothing to read, even if you use Copilot every
day.

- **In the desktop app:** when nothing is being recorded, the app offers to
  turn the setting on for you. You can also do it per editor under
  **Settings > Copilot**. It works for VS Code, Insiders, Cursor, VSCodium and
  Windsurf. Restart the editor afterwards.
- **By hand:** add this to your VS Code user settings, restart, and chat with
  Copilot once:

  ```jsonc
  "github.copilot.chat.otel.dbSpanExporter.enabled": true
  ```

Copilot then writes a file called `agent-traces.db`, which both apps find on
their own. If yours is somewhere unusual, set `agentObservability.sqlitePath`
in the extension.

## Step 3: Look at your sessions

Your sessions appear in the **Sessions** list. Open one to see it turn by turn:
tokens, tools, time and estimated cost.

Some things worth trying:

- **Compare** a few sessions on the same task.
- Read the **retrospective** for a session that went badly.
- Open **Context Hotspots** to see which instruction files and skills your
  agents actually read.
- In the desktop app, open **Improve** to get a suggested plan for your context
  files.

### Optional sources in the VS Code extension

- **Copilot (Cloud):** sessions from the GitHub Copilot coding agent that runs
  on GitHub. Turn on `agentObservability.copilotCloud.enabled`. It signs in
  through the `gh` command-line tool (`gh auth login`). You can also give it a
  token with **Copilot (Cloud): Set account token**. These sessions are
  downloaded to your computer and never uploaded.
- **Workflows:** describe the steps you expect for a repository in
  `agentObservability.workflows`, and sessions that drift from them are
  flagged. This runs on your computer only.

## Step 4 (optional): Share totals with your team

Only do this if your team runs the
[team dashboard](../src/dashboard/AgentObservability.Dashboard). Team sharing
is in the VS Code extension.

You need two things from whoever runs the dashboard: its **address** and an
**API key** (it looks like `aoa_<keyId>_<secret>`).

1. **Set the address.** Open your **user** settings and set
   `agentObservability.sync.dashboardUrl`, for example
   `https://dashboard.example.com`. Only `https://` addresses work. This
   setting is ignored in workspace settings, so a repository you open cannot
   change where your data goes.
2. **Turn on sharing.** Run **Agent Observability: Toggle Cloud Sharing**. A
   dialog shows exactly what is shared and what is not.
3. **Add the API key.** Run **Agent Observability: Set Organization API Key**.
   The key is kept in your system's secure storage (Keychain on macOS,
   Credential Manager on Windows), never in a settings file.
4. **Pick repositories.** Run **Agent Observability: Choose Repositories to
   Sync**. Nothing is uploaded until you pick at least one.
5. **Check it.** Run **Agent Observability: Preview Aggregate Payload** to see
   exactly what would be sent. Then run **Agent Observability: Sync Now**. The
   **Sync** view shows the result.

To sync in the background, turn on `agentObservability.sync.enabled`. It runs
every 60 minutes by default (`agentObservability.sync.intervalMinutes`,
minimum 5). Turning sharing off stops all uploads at once.

### What is shared

- Counts, token totals and timing ranges, in 30-minute blocks, grouped by
  repository, model, agent mode and tool.
- For your context files only (instructions, skills, prompts, agents, hooks):
  the path inside the repository, and counts of how often each was used and
  how those sessions went. Never the file contents.
- All of it under an anonymous id, never your name or email.

### What is not shared

Prompts, responses, file contents, paths of any other files, commit hashes,
branch names, your computer's name, your username, and your email. Sessions
from the Copilot coding agent are never shared either.

The upload formats are fixed in
[schemas/aggregate-batch.schema.json](../schemas/aggregate-batch.schema.json)
and
[schemas/context-insights-batch.schema.json](../schemas/context-insights-batch.schema.json).
The dashboard rejects anything that does not match. The full rules, and how
they are tested, are in [privacy-validation.md](privacy-validation.md).

## Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| No Copilot sessions | Copilot tracing is off | See step 2, then restart the editor and chat with Copilot once. |
| No Claude Code sessions | Sessions are stored somewhere else | Set `agentObservability.claudeCode.projectsPath` (extension) or the path in the app's Settings. |
| Sync view says "Dashboard URL: Not set" | No address, or not `https://` | Set `agentObservability.sync.dashboardUrl` in your user settings. |
| Sync never runs | Sharing off or no API key | Turn on sharing and add the API key (step 4). |
| Upload rejected (401) | Wrong or expired API key | Ask for a new key and set it again. |
| Upload rejected (400) | The app and dashboard disagree on the format | Update the extension. |
| Upload rejected (503) | The dashboard has uploads turned off | Ask whoever runs the dashboard to set `Ingestion:Enabled=true`. |
| Copilot (Cloud) says "GitHub CLI not found" | `gh` is not on your PATH | Set `agentObservability.copilotCloud.ghCliPath`, or add a token with **Copilot (Cloud): Set account token**. |

## More reading

- [Privacy rules and how they are enforced](privacy-validation.md)
- [Architecture and upload formats](architecture/)
- [VS Code extension settings and commands](../src/extension/agent-observability-vscode/README.md)
- [Desktop app](../src/desktop/agent-observability-desktop/README.md)
