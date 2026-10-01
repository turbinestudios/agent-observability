# Agent Observability (Local)

Look back at your AI coding sessions without leaving VS Code.

The extension reads the sessions that **GitHub Copilot** and **Claude Code**
record on your computer and shows what each one did, what it cost, and where it
went off track. Your prompts, responses, tool calls and file paths stay on your
machine. Sharing totals with a team dashboard is optional and off by default.

## What you get

Open **Agent Observability** in the Activity Bar. It has five views:

- **Local Overview:** a summary of recent agent activity.
- **Sessions:** every session, grouped by source and repository. Open one to
  see it turn by turn, with tokens, tools, time and cost.
- **Sync:** the status of team sharing, if you use it.
- **Context Hotspots:** which instruction files, skills and prompts your
  agents actually read, and how those sessions went.
- **AI Helper:** a chat that answers questions about your sessions and helps
  you set things up.

You can also type `@obs` in Copilot Chat to open a session's detail.

### Sources

| Source | What it reads | Setup |
| --- | --- | --- |
| **Copilot** | Copilot Chat's local `agent-traces.db` | Turn on `github.copilot.chat.otel.dbSpanExporter.enabled` (off by default), restart, chat once. |
| **Claude Code** | Transcripts in `~/.claude/projects` | None. |
| **Copilot (Cloud)** | Sessions from the Copilot coding agent on GitHub | Turn on `agentObservability.copilotCloud.enabled` and sign in with `gh auth login`. |
| **Copilot (Autonomous)** | Copilot CLI agents that report to a relay you run | Turn on `agentObservability.copilotAgent.enabled` and set the relay endpoint and token. |

Copilot keeps only a short rolling history. The extension copies it into an
archive under your home folder, so older sessions stay available and appear in
every VS Code window (`agentObservability.copilotArchive.*`).

## AI Helper

The AI Helper answers with **your own** AI subscription. Choose the backend in
the view or with `agentObservability.aiHelper.backend`:

- **GitHub Copilot** (default), through VS Code's language model API.
- **Claude Code**, through the `claude` command-line tool and your own login.

When the chat is empty it offers three shortcuts:

- **Generate workflows:** drafts an `agentObservability.workflows` entry from
  your project's Copilot customization files. You confirm before it is saved
  to `.vscode/settings.json`, and entries for other repositories are kept.
- **Set up new project:** writes the minimum settings to get started. The API
  key is never written to a settings file.
- **Summarize my logs:** a plain-language summary of your recent sessions.

**What it sends.** Your question, plus safe facts about your sessions:
repository names, agent, model and tool names, durations, and token and cost
figures. **Generate workflows** also sends the contents of your customization
files so it can work out the intended workflow. It never sends your prompts,
responses or tool input and output, and it has nothing to do with team
sharing. The first time you use it, it shows this notice.

## Cost

A session's detail shows Copilot's billed usage (AIU) and the cost derived from
it at 1 AIU = $0.01. Claude Code sessions show a cost estimated from token
prices. Cost figures stay on your machine and are never shared.

## Workflows and flagged sessions

Describe the steps you expect for a repository in
`agentObservability.workflows`, and the extension flags turns that skip a step,
run steps in the wrong order, take too long, or fail too often. Flags show in
the session detail. Turn on `agentObservability.deviation.notifyOnDivergence`
to also get a notification.

There are two kinds of checks, and both run only on your computer:

- **Metadata checks** match on `operation`, `agentName`, `agentMode`, `model`,
  `toolName` and `success`. Every field is optional, and text matches ignore
  case. Use them in `steps[].predicate` and in `triggerPredicate`, which decides
  whether a workflow applies to a turn. Steps must then appear in order, though
  not necessarily next to each other. The older `expectedSequence` (a list of
  agent names) still works. Do not scope a workflow by `agentMode` alone: every
  custom chat mode reports as `custom`.
- **Content checks** (`contentPredicate`) look inside the raw text, for example
  the prompt, using `contains`, `matches` (a regular expression) and `negate`.
  Only a fixed list of local-only keys can be inspected. Regular expressions
  that could run very slowly are rejected, and only the first 1,000 characters
  are searched (10,000 for `contains`). `triggerContentPredicate` does the same
  for whether a workflow applies at all.

```jsonc
"agentObservability.workflows": [
  {
    "repository": "https://github.com/org/repo",
    "workflows": [
      {
        "name": "feature-development",
        "triggerPredicate": { "operation": "invoke_agent" },
        "steps": [
          { "name": "plan", "predicate": { "agentName": "planner", "operation": "chat" } },
          { "name": "code", "predicate": { "agentName": "coder", "toolName": "edit_file" } },
          {
            "name": "no-secrets-in-prompt",
            "predicate": { "operation": "chat" },
            "contentPredicate": { "attribute": "copilot_chat.user_request", "contains": "AKIA", "negate": true }
          }
        ],
        "maxDurationMinutes": 45
      }
    ]
  }
]
```

A content check only produces yes or no. The matched text is never copied into
the flag, which names only the step. Flags from content checks carry a
**Local only** badge, and no flag is ever uploaded.

## Live updates

Run **Agent Observability: Enable Live Updates (Copilot OTel)** to see Copilot
sessions update as they happen. The extension starts a small receiver on
`127.0.0.1` and Copilot sends its telemetry there instead of to its own
database. Nothing leaves your computer. Copilot reads this setting only at
startup, so **quit and reopen VS Code** afterwards; reloading the window is not
enough. With several windows open, one runs the receiver and the others follow
it. **Disable Live Updates** turns it off.

## Team sharing (optional)

If your team runs the
[team dashboard](https://github.com/turbinestudios/agent-observability/tree/main/src/dashboard/AgentObservability.Dashboard),
you can share totals with it:

1. Set `agentObservability.sync.dashboardUrl` in your **user** settings to the
   dashboard's `https://` address. Workspace settings cannot set or change it.
2. Run **Toggle Cloud Sharing** and read what is and is not shared.
3. Run **Set Organization API Key**. The key is kept in your system's secure
   storage, never in a settings file.
4. Run **Choose Repositories to Sync**. Nothing uploads until you pick one.
5. Run **Preview Aggregate Payload** to see exactly what would be sent, then
   **Sync Now**.

Only counts and totals are shared, under an anonymous id, plus the
repository-relative paths of your context files with their counts. Prompts,
responses, file contents, other file paths, branches, commits and your identity
are never shared. Copilot (Cloud) and Copilot (Autonomous) sessions are never
shared.

## Commands

All under **Agent Observability** in the Command Palette:

- Refresh, Open Settings, Show Logs
- Open Session Detail, Open Combined Detail, Open Repository Details
- Open AI Helper, New AI Helper Chat
- Enable Live Updates (Copilot OTel), Disable Live Updates
- Toggle Cloud Sharing, Set Organization API Key, Choose Repositories to Sync,
  Preview Aggregate Payload, Sync Now
- Choose Repositories to Hide
- Copilot (Cloud): Set account token
- Copilot (Autonomous): Set relay token

## Main settings

Every setting is listed, with a description, under **Agent Observability** in
VS Code's Settings editor. The ones you are most likely to change:

| Setting | Default | What it does |
| --- | --- | --- |
| `agentObservability.sqlitePath` | `""` | Path to Copilot's `agent-traces.db`. Empty finds it automatically. |
| `agentObservability.claudeCode.enabled` | `true` | Show Claude Code sessions. |
| `agentObservability.claudeCode.projectsPath` | `""` | Where Claude Code keeps transcripts. Empty uses `~/.claude/projects`. |
| `agentObservability.excludedRepositories` | `[]` | Repositories to hide everywhere in the extension. Use **Choose Repositories to Hide**. |
| `agentObservability.aiHelper.backend` | `"copilot"` | Which AI answers in the AI Helper: `copilot` or `claude-code`. |
| `agentObservability.workflows` | `[]` | Expected workflows per repository (see above). |
| `agentObservability.deviation.maxSessionMinutes` | `60` | A turn longer than this is flagged. |
| `agentObservability.copilotCloud.enabled` | `false` | Show Copilot coding-agent sessions from GitHub. |
| `agentObservability.copilotCloud.scope` | `"my-tasks"` | `my-tasks`, or `repos` to include teammates' tasks in your repositories (you will see their prompts, as on github.com). |
| `agentObservability.sync.dashboardUrl` | `""` | Your team dashboard's `https://` address. User settings only. |
| `agentObservability.sync.enabled` | `false` | Upload totals in the background. |
| `agentObservability.sync.intervalMinutes` | `60` | How often background sync runs (minimum 5). |

## Privacy

Prompts, responses, system instructions, tool input and output, reasoning,
file paths, commit hashes, branch names, your computer's name, your username
and your email never leave your computer. The only uploads are the team-sharing
batches described above, after you opt in. The full rules and how they are
tested are in
[docs/privacy-validation.md](https://github.com/turbinestudios/agent-observability/blob/main/docs/privacy-validation.md).

## Contributing

See [DEVELOPMENT.md](DEVELOPMENT.md) for building and the code layout.

Agent Observability is an independent project, not affiliated with or endorsed
by GitHub, Microsoft or Anthropic.
