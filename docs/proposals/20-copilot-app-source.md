# 20. The GitHub Copilot app as a session source

## User story

As a developer who also works in the GitHub Copilot desktop app, I want those
sessions listed as **Copilot app**, with their project and token counts, so
that I can tell them apart from my terminal Copilot sessions and they do not
look missing.

**Acceptance criteria**

- Sessions the Copilot app wrote appear under the source **Copilot app**, with
  their own filter chip, chart colour and Settings toggle (on by default). They
  no longer appear under Copilot CLI.
- A session an earlier release filed under Copilot CLI moves to Copilot app on
  the next index pass, even though its file has not changed.
- An app session's repository comes from the folder attached to the chat
  when the chat's own working folder is the app's scratch folder.
- An app session shows input, output and cached tokens. A Copilot CLI session
  that ended without a clean shutdown shows them too.
- In a team shard, app sessions count as Copilot CLI sessions. The shard
  schema does not change.
- The app only reads the Copilot store. Deleting an app session is hide-only,
  and Resume in terminal is not offered for it.

## Why this matters for research

The Copilot app runs the same agent runtime as the CLI, so its sessions were
already being read, just filed under the wrong name, with no repository and no
token counts. For the person who reported it, that was indistinguishable from
"not picked up". Comparing how the same agent behaves in the app and in the
terminal needs the two kept apart.

## Agent spec

**Goal.** Split the runtime's shared session store into two sources by the
client that wrote each session, recover the repository and usage the app's
sessions lack, and keep the shard contract closed.

**Grounding: what is on disk (verified against Copilot app 1.1.24, 2026-10-06)**

- The app ("GitHub Copilot", GitHub Inc., a Rust + WebView2 app at
  `%LOCALAPPDATA%\Programs\GitHub Copilot`) bundles the Copilot SDK and starts
  the CLI runtime in server mode. Its sessions land in
  `~/.copilot/session-state/<uuid>/`, exactly like the CLI's.
- `workspace.yaml` carries `client_name: github/autopilot` (the CLI writes
  `github/cli`, the SDK `sdk`), plus app-only `mc_task_id`, `mc_session_id`
  and `remote_steerable`. Nothing in `events.jsonl` tells the clients apart
  (`producer` is `copilot-agent` for all of them).
- Most app session folders are pool stubs without an `events.jsonl`; the
  existing discovery already skips them.
- The chat's `cwd` is a scratch folder `~/.copilot/chats/<date>/<slug>`, not a
  checkout. The project appears only as a `user.message` attachment with
  `type: directory`.
- App sessions write no `session.shutdown`; `session.usage_checkpoint` holds
  only `totalNanoAiu` and `totalPremiumRequests`, and `assistant.message`
  carries no `outputTokens`. Per-call usage is in the runtime's own
  `~/.copilot/session-store.db`, table `assistant_usage_events` (`session_id`,
  `model`, `input_tokens`, `output_tokens`, `cache_read_tokens`,
  `cache_write_tokens`, `reasoning_tokens`, `total_nano_aiu`, …). The file is
  in WAL mode with nearly all of its data in `-wal`. `input_tokens` includes
  cache reads, matching the shutdown event for a CLI session that has both.
- The app's own `~/.copilot/data.db` holds UI state, workspaces and context
  usage, but no transcripts, and is not read.

**Grounding: what was built**

- `copilotCli/events.ts`: `cliClientOf(workspace)` → `'app' | 'cli'`.
- `copilotCli/copilotCliSource.ts`: one class, constructed per client;
  `copilot-app` is labelled "Copilot app" and has its own enable flag
  (`copilotApp.enabled`).
- `copilotCli/mapper.ts`: `resolveCliRepository` falls back to attached
  directories through the same git-remote lookup; `resolveCliUsage` takes the
  store's usage only when the events carry no token totals, and keeps the
  events' AIU when they have one.
- `copilotCli/sessionStoreUsage.ts`: one grouped query over a snapshot copy,
  cached until the store or its `-wal` changes. Only numeric columns and the
  model are selected.
- Desktop: the CLI indexer runs once per client and skips another client's
  sessions before its unchanged-file shortcut (which is what moves old rows);
  the live board attributes rows by client; `shardSource()` folds
  `copilot-app` into `copilot-cli` for shards.

**Constraints**

- Read-only over `~/.copilot`, including `session-store.db`.
- No index schema change and no shard schema change: tags from 2.0.0 read
  shards, so a new source name in a shard would make older readers reject it.

**Out of scope**

- Reading `data.db` for titles or project links.
- Resume in terminal for app sessions (`copilot --resume` on them is untested).

**Verification**

- Tests under `os.tmpdir()`: client classification, both sources listing
  disjoint sessions, re-filing an old row, the attachment fallback, store usage
  from a genuine WAL-mode file kept open by its writer, the shard fold, the
  live board's attribution.
- On the machine that reported it: the 30 September app session lists as
  Copilot app with 1.12M input tokens, where 2.1.1 showed it as Copilot CLI
  with none.
