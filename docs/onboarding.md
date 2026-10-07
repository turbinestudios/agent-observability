# Getting started

Agent Observability reads the sessions your AI coding agents record on your
computer and lets you look back at them. It is a desktop app for macOS and
Windows.

Everything in steps 1 to 3 stays on your computer. Step 4, team sharing, is
optional and off by default.

## Step 1: Install

Download the installer for your system from
[Releases](https://github.com/turbinestudios/agent-observability/releases).

- **macOS:** open the `.dmg` and drag the app to Applications. There are builds
  for Apple Silicon (`arm64`) and Intel (`x64`). The app is signed and
  notarized.
- **Windows:** run the `.exe`. The installer is not signed yet, so SmartScreen
  may warn you. Choose **More info**, then **Run anyway**.

The app checks for updates when it starts and always asks before downloading.

## Step 2: Make sure your agent is recording

**Claude Code** always saves its sessions under `~/.claude/projects`. There is
nothing to set up.

**GitHub Copilot** only saves sessions while one setting is on, and it is off
by default. Without it there is nothing to read, even if you use Copilot every
day.

- **In the app:** when nothing is being recorded, the app offers to
  turn the setting on for you. You can also do it per editor under
  **Settings > Copilot**. It works for VS Code, Insiders, Cursor, VSCodium and
  Windsurf. Restart the editor afterwards.
- **By hand:** add this to your VS Code user settings, restart, and chat with
  Copilot once:

  ```jsonc
  "github.copilot.chat.otel.dbSpanExporter.enabled": true
  ```

Copilot then writes a file called `agent-traces.db`, which the app finds on
its own. If yours is somewhere unusual, set **Copilot database** under
**Settings**.

## Step 3: Look at your sessions

Your sessions appear in the **Sessions** list. Open one to see it turn by turn:
tokens, tools, time and estimated cost.

Some things worth trying:

- **Compare** a few sessions on the same task.
- Read the **retrospective** for a session that went badly.
- Open **Context Hotspots** to see which instruction files and skills your
  agents actually read.
- Open **Improve** to get a suggested plan for your context files.

## Step 4 (optional): Share totals with your team

Team sharing works through a folder your team already shares, such as
OneDrive, SharePoint or a network drive. There is no server and no account.
Each member's app writes one file there and reads everyone else's.

1. **Turn on the Team view.** Under **Settings > Team**, turn on **Show the
   Team view**.
2. **Choose the folder.** Next to **Team folder**, choose the shared folder.
   The app only reads it. The one file it writes there is your own, and only
   once you turn sharing on.
3. **Look before you share.** **Preview what will be shared** shows the exact
   file the app would write.
4. **Turn on sharing.** Turn on **Share my aggregates with the team folder**.
   A dialog shows exactly what is shared and lets you pick the repositories
   to include. Nothing is written until you confirm.
5. **Share.** Use **Export now** in the **Team** view, or turn on **Export
   automatically every hour while the app runs**.

Turning off the Team view also stops sharing. Each install has its own
anonymous id, so the same person on two computers counts twice.

### What is shared

- Counts, token totals and timing ranges, in 30-minute blocks, grouped by
  repository, model, agent mode and tool.
- Per day and repository: how many sessions there were, how they went, and
  their estimated cost.
- For your context files only (instructions, skills, prompts, agents, hooks):
  the path inside the repository, and counts of how often each was used and
  how those sessions went. Never the file contents.
- All of it under an anonymous id, never your name or email.

### What is not shared

Prompts, responses, file contents, paths of any other files, commit hashes,
branch names, your computer's name, your username, and your email. Sessions
from Copilot in JetBrains IDEs are never shared either.

The file format is fixed in
[schemas/team-shard.schema.json](../schemas/team-shard.schema.json), which
includes
[schemas/aggregate-batch.schema.json](../schemas/aggregate-batch.schema.json)
and
[schemas/context-insights-batch.schema.json](../schemas/context-insights-batch.schema.json)
unchanged. The app checks every file against it, and skips with a notice any
file in the folder that does not match. The full rules, and how they are
tested, are in [privacy-validation.md](privacy-validation.md).

## Troubleshooting

| What you see | Likely cause | What to do |
| --- | --- | --- |
| No Copilot sessions | Copilot tracing is off | See step 2, then restart the editor and chat with Copilot once. |
| No Claude Code sessions | Sessions are stored somewhere else | Set **Claude Code projects folder** under **Settings**. |
| Copilot tracing is on but no sessions | `agent-traces.db` is somewhere unusual | Set **Copilot database** under **Settings**. |

## More reading

- [Privacy rules and how they are enforced](privacy-validation.md)
- [Architecture and data formats](architecture/)
- [Desktop app](../src/desktop/agent-observability-desktop/README.md)
