# 22. OpenCode as a session source

## User story

As a developer who runs OpenCode, often signed in with my GitHub Copilot
subscription, I want those sessions listed beside my other agent sessions,
with the provider and model that served each one, so that the app shows all
my agent work, including the Copilot use that happens outside GitHub's own
clients.

**Acceptance criteria**

- OpenCode sessions appear under the source **OpenCode**, one per root session,
  with title, repository, turns, tool calls, tokens and times.
- The model reads `provider/model` (`github-copilot/claude-sonnet-4.5`,
  `openai/gpt-5.4`), so a Copilot-served session is recognisable as one.
- Cost is the USD OpenCode recorded. Turns served through a GitHub Copilot
  login are billed as premium requests, which OpenCode does not record, so they
  stay **unpriced, never $0**.
- Sub-agent sessions (`task` tool children) fold into their root as sub-agent
  usage, named by their agent (`explore`, `general`, …).
- Settings has a toggle (on by default) and a database override, and says
  which file it reads and whether it is there.
- The app only reads OpenCode's data. Deleting a session is hide-only. These
  sessions are not shared in team shards.

## Why this matters

OpenCode signs in to Copilot with its own GitHub device-flow login and calls
the Copilot API directly. Nothing reaches `~/.copilot/session-state`, the
Copilot app's `session-store.db`, VS Code's `agent-traces.db` or the JetBrains
stores, so before this source that use was invisible to the app.

## Agent spec

**Grounding: the store (verified on disk, opencode 2.1.2, October 2026)**

- `<XDG_DATA_HOME or ~/.local/share>/opencode/opencode.db`, on Windows too
  (`%USERPROFILE%\.local\share\opencode`). `OPENCODE_DB` moves it. It is a
  SQLite database in WAL mode, with schema managed by Drizzle migrations.
  Builds before the SQLite move kept JSON files under `storage/`; that layout
  is not read.
- `session`: `id`, `project_id`, `parent_id` (sub-agent child), `title`
  (`New session - <iso>` until generated), `directory`, `version`, times in ms.
- `message.data` (JSON): `role`, `providerID`, `modelID`, `agent`, `parentID`
  (the user message an assistant message answers), `time`,
  `tokens {input, output, reasoning, cache {read, write}}`, `cost`, `error`.
  User messages carry the model as `model {providerID, modelID}`.
- `part.data` (JSON): `type` ∈ `text | reasoning | tool | step-start |
  step-finish`; tool parts carry `tool`, `state.status`, `state.time`.
- The same folder holds `auth.json` and the `account`, `credential` and
  `control_account` tables. None is ever read.

**What was built**

- Core `opencode/`: `paths.ts`, `store.ts` (snapshot copy, explicit
  `json_extract` fields only, re-read when the file or its `-wal` moves),
  `mapper.ts`, `opencodeSource.ts` (`costMode: 'usd'`).
- Desktop: `opencodeIndexer.ts` (one `files` row for the database carrying the
  ids it produced), worker and live board wiring (database and `-wal`
  watched), Settings toggle, database override and resolution line, source
  chip and chart colour, hide-only deletion text.

**Constraints**

- Read-only, through the shared snapshot copy; the original file is never
  opened.
- Never tool input or output, never reasoning text, never synthetic text
  parts.
- Not shared in team shards; no shard or index schema change.

**Out of scope**

- The legacy JSON `storage/` layout.
- Estimating Copilot premium requests per turn; the multiplier per model is
  not recorded locally.
- Live status rows and context analysis for this source.

**Verification**

- Core tests build a WAL-mode store with the real DDL: a Copilot-served
  session with a sub-agent, an OpenAI-served one with an error, placeholder
  titles, synthetic text, a planted credential and tool payload that must
  never surface, and an untouched source file.
- Desktop tests: an unchanged store is skipped, a moved one re-read, a removed
  one drops its rows.
- Checked against a copy of a real store: totals per session match the
  `session` table's own token and cost columns.
