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
- Cost is the USD OpenCode recorded, except for turns served through a
  GitHub Copilot login. OpenCode records an API list-price estimate for
  those, which is not what Copilot charges. They show the **GitHub AI
  credits** computed from their tokens at Copilot's per-model rates, with
  the credits' dollar value ($0.01 each) as their cost. A model with no
  published rate stays **unpriced, never $0 and never the list price**.
  (Before 2.4.5 every Copilot turn stayed unpriced.)
- Each agent and sub-agent shows its run time: the time its model calls and
  their tools were running, with idle gaps between resumes left out.
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
- **Two table layouts share the file.** OpenCode 2.x writes `session_v2` and
  `session_message` and migrates the 1.x rows into them, leaving the 1.x
  tables behind with only the old sessions. The reader uses the v2 tables
  whenever they exist, and the 1.x tables only when they do not. (2.4.1 read
  only the 1.x tables, so it missed every session written by OpenCode 2.x.)
- `session_v2`: as 1.x `session` below, plus `model {id, providerID,
  variant}`, `agent`, and per-session token and cost totals that equal the
  sum of its messages.
- `session_message`: `type`, `seq` and `data`. Only `user` and `assistant`
  are turns; `synthetic`, `system`, `shell`, `idle`, `compaction`,
  `agent-switched` and `model-switched` are skipped. A user message is
  `{text, time}`. An assistant message is `{agent, model {id, providerID},
  tokens, cost, time, error {type}, content[]}`, whose `content` items are
  `text`, `reasoning`, or `tool {name, state {status, input, content}, time
  {created, completed}}`. Assistant messages carry no `parentID`; they answer
  the user message before them in `seq` order.
- 1.x `session`: `id`, `project_id`, `parent_id` (sub-agent child), `title`
  (`New session - <iso>` until generated), `directory`, `version`, times in ms.
- 1.x `message.data` (JSON): `role`, `providerID`, `modelID`, `agent`, `parentID`
  (the user message an assistant message answers), `time`,
  `tokens {input, output, reasoning, cache {read, write}}`, `cost`, `error`.
  User messages carry the model as `model {providerID, modelID}`.
- 1.x `part.data` (JSON): `type` ∈ `text | reasoning | tool | step-start |
  step-finish`; tool parts carry `tool`, `state.status`, `state.time`.
- The same folder holds `auth.json` and the `account`, `credential` and
  `control_account` tables. None is ever read.

**Grounding: Copilot AI credits (verified October 2026)**

- Copilot bills AI credits per token (1 credit = 1 AIU = $0.01) at per-model
  input, cached-input, cache-write and output rates, some with a long-context
  tier, published at
  https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing.
- Checked against `assistant_usage_events` in the Copilot CLI's
  `session-store.db`: a least-squares fit of `total_nano_aiu` on the four
  token buckets reproduces every call with zero error and yields exactly the
  published rates. The request multiplier plays no part.
- OpenCode's own costs for Copilot turns use other rates: no cache-write
  charge, for one. On the reference store, the credits come to about $366
  where OpenCode recorded $225.
- OpenCode's v2 tokens are disjoint (`input` is fresh; cache read and write
  are separate), and reasoning is counted apart from output, so the credits
  bill `output + reasoning` at the output rate.

**Grounding: what OpenCode records about context (2.x)**

- `instruction_state`: per session, `initial_values` and `current_values`,
  each a JSON map from an instruction block (`core/instructions`,
  `core/skill-guidance`, `core/environment`, `core/date`, …) to an
  `instruction_blob` hash. The `core/instructions` blob is
  `[{path, content}]`, one entry per instruction file put in the context
  (AGENTS.md, CLAUDE.md, configured instructions).
- `session_message` rows of type `synthetic` with
  `metadata.instruction.paths`: a nested AGENTS.md loaded as the agent worked
  in a sub-folder; `text` is `Instructions from: <path>` plus the file.
- `skill` tool calls carry the skill as `state.input.id`; `read` calls carry
  `state.input.filePath`.

**What was built**

- Core `opencode/`: `paths.ts`, `store.ts` (snapshot copy, explicit
  `json_extract` fields only, re-read when the file or its `-wal` moves),
  `mapper.ts`, `opencodeSource.ts` (`costMode: 'usd'`), and
  `contextAnalysis.ts`.
- **Context Analysis tab** (2.4.4), through the shared pipeline the Claude and
  Copilot sources use. The instruction files come from OpenCode's own record,
  sized from the text it loaded. Skills come from `skill` calls, with sizes
  from the `SKILL.md` on disk (project `.opencode/skill(s)`, `.claude/skills`
  and `.agents/skills` from the session folder upwards, then the same under
  the home folder). Context files the agent read are listed too. There is one
  main agent and one row per sub-agent type, and the context window is the
  largest `input + cache read + cache write` of any call. The same analysis
  feeds Context Hotspots and Improve. Core's size estimator now keeps a size
  the source recorded.
- Desktop: `opencodeIndexer.ts` (one `files` row for the database carrying the
  ids it produced and the reader version, so a reader change re-reads an
  unchanged file and marks its sessions for re-analysis), worker and live
  board wiring (database and `-wal` watched), Settings toggle, database
  override and resolution line, source chip and chart colour, hide-only
  deletion text.

**Constraints**

- Read-only, through the shared snapshot copy; the original file is never
  opened.
- Never tool output, never reasoning text, never synthetic text parts as
  conversation. Of tool input, exactly two fields: a `skill` call's id, and a
  `read` call's path only when it names a context file; any other path is
  dropped as it is read. Instruction files are kept as path and length,
  never their text.
- Not shared in team shards; no shard or index schema change.

**Out of scope**

- The legacy JSON `storage/` layout.
- Live status rows for this source.
- Context analysis on the 1.x layout beyond context files read and the
  window size: those builds record no instruction loads.

**Verification**

- Core tests build WAL-mode stores in both layouts.
  - The 2.x store has a migrated 1.x session that must be counted once,
    inline tool calls, skipped message types, and list-price costs on Copilot
    turns that must stay unpriced.
  - The 1.x store has a Copilot-served session with a sub-agent, an
    OpenAI-served one with an error, placeholder titles, synthetic text, a
    planted credential and tool payload that must never surface, and an
    untouched source file.
- Desktop tests: an unchanged store is skipped, a moved one re-read, a removed
  one drops its rows.
- Checked against a copy of a real 2.x store: all 9 root sessions (7 on
  GitHub Copilot, 2 on OpenAI) appear with their sub-agents, and their totals
  match each session's own token and cost columns.
