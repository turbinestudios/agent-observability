# 14. Copilot CLI as a session source

## User story

As a developer who runs GitHub Copilot from the terminal, I want those sessions
to appear beside my Claude Code and VS Code Copilot sessions, with the same
retrospective, cost and live-board treatment, so that the app shows all my
agent work wherever it started.

**Acceptance criteria**

- Sessions under `~/.copilot/session-state` that have an `events.jsonl` appear
  in Sessions under the source **Copilot CLI**, with title, repository,
  duration, turns, tool calls, tokens, model and AIU cost. Directories without
  an `events.jsonl` (most of them are stubs) produce no row.
- The app's own helper runs (AI Helper, Deep Retrospective and Improvement
  Plans on the Copilot backend) never appear in any list or count.
- Session detail shows turns, tool calls with success or failure, and the
  heuristic retrospective; plan and autopilot mode switches, steering
  messages, failed tools and allow-all toggles feed its findings.
- A running CLI session is on the live board as working, waiting, idle or
  finished, with pending tool names. Because permission prompts are not
  written to disk, a stalled tool request reads "may be waiting for approval".
- A missing `~/.copilot` is a quiet, empty source. A settings toggle turns the
  source off (default on, like the other local sources).
- The app only reads `~/.copilot`. It never writes or deletes there; the
  delete-session flow for this source is hide-only.
- Nothing about these sessions reaches the team shard in this release, and the
  Team view says so.

## Why this matters for research

The terminal is where a growing share of Copilot work happens, and it is the
storage format the Copilot SDK also writes. Until this source exists the app
sees one of Copilot's two front ends, and proposal 15 (Run) has nowhere to land
the sessions it hosts. Reading the format once, here, means every later feature
(completion checks, review packets, the inbox) gets Copilot CLI for free.

## Agent spec

**Goal.** A new `SessionDataSource` over the Copilot CLI's on-disk session
state, a desktop indexer for it, a live-board candidate provider, and
deterministic exclusion of the app's own helper runs. No index schema change.

**Grounding: what is on disk (verified against CLI 1.0.90, 2026-10-06)**

- `~/.copilot/session-state/<uuid>/` holds `workspace.yaml` (flat `key: value`:
  `id`, `cwd`, `git_root`, `repository` as `owner/name`, `branch`,
  `client_name`, `name`, `summary`, `created_at`, `updated_at`),
  `events.jsonl`, `checkpoints/`, `files/`, and `inuse.<pid>.lock` while a
  process is attached. `session-store.db` sits beside the folder.
- Event envelope `{ type, data, id, timestamp, parentId }`. Types seen:
  `session.start | resume | shutdown | usage_checkpoint | model_change |
  mode_changed | permissions_changed`, `user.message`, `assistant.message`,
  `assistant.turn_start | turn_end`, `tool.execution_start | execution_complete`,
  `hook.start | end`, `system.message | notification`.
- **Usage is not on `assistant.usage`** (never persisted). It is on
  `session.shutdown.data` (`tokenDetails`, `modelMetrics[model].usage`,
  `totalNanoAiu`, `totalPremiumRequests`, `codeChanges`),
  `session.usage_checkpoint.data` (`totalNanoAiu`, `totalPremiumRequests`) and
  `assistant.message.data.outputTokens`. One session can hold several
  shutdowns (one per resume).
- `session.idle` and permission events are **not** persisted.
- `session.start.data.producer` is the literal `copilot-agent`, which is also
  the id of the cloud-agent source: never derive a source id from it.

**Grounding: what to build**

- Core, new `src/core/agent-observability-core/src/copilotCli/` (no `vscode`,
  filesystem behind a seam like `claude/paths.ts`): `paths.ts` (honours
  `COPILOT_HOME`; `discoverCopilotCliSessions`), `workspaceYaml.ts` (a flat
  reader; no YAML dependency), `events.ts` (tolerant JSONL reader, unknown
  types kept and ignored), `mapper.ts` (`mapCopilotCliSession` → summary,
  detail, interactions), `usage.ts`, `retrospectiveSignals.ts`,
  `eventsTail.ts` (bounded tail read, modelled on `claude/transcriptTail.ts`),
  `helperRuns.ts` (`isHelperRun`), `copilotCliSource.ts`.
- `telemetry/models.ts`: add `'copilot-cli'` to `AgentSourceId`. Label
  "Copilot CLI", cost mode `aiu`. Add the label to
  `analysis/repositoryDigest.ts` `sourceLabel` and the renderer's
  `SOURCE_LABELS` (`views/sessions/format.ts`).
- Mapping: a turn is one `user.message` through the `assistant.turn_end`
  before the next; an interaction is one `assistant.message` or one
  `tool.execution_start`/`_complete` pair joined on `toolCallId`; agent modes
  from `session.mode_changed`; title from `workspace.yaml` `name`, else
  `summary`, else the first prompt (derived).
- Repository, in order: `workspace.yaml` `repository`, the last
  `session.start`/`resume` `context.repository`, `cwd` through
  `claude/gitRemote.ts` and `repo_cache`, then `unknown`; normalised with the
  same function the Claude indexer uses so hubs merge across sources.
- Cost: finished segments from `session.shutdown`, the open segment from the
  last `usage_checkpoint`; through the existing Copilot AIU path. A session
  with neither is unpriced (`cost_micros NULL`), never zero.
- **Helper exclusion, two layers, shipped in the same release as the source.**
  `CopilotCliBackend` (`chat/backends/copilotCliBackend.ts`) spawns in a
  dedicated empty directory `~/.agent-observability/helper-cwd`; the indexer
  drops any session whose `session.start` cwd is that directory. Legacy runs:
  drop sessions with the home directory as cwd, exactly one `user.message`, and
  either no tool call or a single `view` whose prompt starts with the exported
  payload-pointer prefix from `copilotCliArgs.ts`. Replace the warning comment
  at `copilotCliArgs.ts:25-27` with the rule now enforced.
- Live status from the tail of `events.jsonl`: `finished` on `session.shutdown`;
  `working` on an unmatched `tool.execution_start`, `assistant.turn_start`,
  `user.message` or `tool.execution_complete`; `idle` on `assistant.turn_end`;
  `waiting` when the last `assistant.message` has `toolRequests` with no
  matching start past the waiting threshold. `LiveSessionRow` gains
  `waitingFor?: 'approval' | 'input'` and `exact?: boolean` (false here; true
  for sessions hosted by proposal 15).
- Desktop: `datahost/indexer/copilotCliIndexer.ts` (the two-phase shape of
  `claudeIndexer.ts`), a third indexer in `background/worker.ts` in its own
  try block, a candidate provider and a watch on `session-state` in
  `live/liveBoard.ts`, a hide-only plan in `deletion.ts`, a settings toggle,
  the source filter chip, a Team view note.

**Constraints**

- **Privacy.** Read-only over `~/.copilot`. Session content stays local like
  every other source. `getAggregationRows` is implemented for the contract,
  but the team shard's outcome rows keep their closed `source` enum
  (`claude`, `copilot`) and drop `copilot-cli`; do not fold these sessions
  into `copilot`, and do not widen the enum here (older readers would reject
  whole shards). A shard schema 1.1 is its own proposal.
- No `SCHEMA_VERSION` bump: rows fit `sessions`.
- The format is undocumented and will change: record `copilotVersion`, ignore
  unknown event types, never throw on a truncated last line, and label test
  fixtures with the CLI version probed.
- If a `copilot` (VS Code OTel) row with the same session id exists, keep the
  `copilot-cli` row and log once.

**To verify before building (SDK spike, see proposal 15)**

- Whether `session.shutdown` totals are per process segment or cumulative
  across resumes (decides sum versus last).
- Whether VS Code-started CLI sessions also appear in the OTel `copilot`
  source.

**Out of scope**

- Context analysis and hotspots for this source (no "instruction loaded"
  event was found); the Context tab is hidden for it.
- `session-store.db`, checkpoint and `plan.md` rendering.
- Team shard rows; deleting CLI sessions; any extension UI.

**Verification**

- `npm run typecheck --workspaces --if-present`, `npm run lint --workspaces
  --if-present`, `npm test --workspaces --if-present`.
- Tests build synthetic session folders under `os.tmpdir()` with `path.join`:
  turn pairing, orphan tool starts, multiple shutdowns, an open segment, the
  unpriced case, a truncated last line, stub directories skipped, helper
  exclusion by marker cwd and by the legacy rule (and a real two-prompt
  home-cwd session that must **not** be dropped), each live status with a
  fake pid probe, and that `copilot-cli` rows reach a team shard under their
  own source (see "What was settled differently").
- Manual: run `copilot` in a repository; the session appears under Copilot
  CLI with cost and turns. Run the AI Helper on the Copilot backend; no new
  session appears.

## What was settled differently

- **Copilot CLI sessions count in the team shard.** The spec kept them out
  because the shard's `source` enum was closed and older readers would reject
  a file naming a new source. No version that reads shards had been tagged
  when this landed (the newest release was 1.15.0), so the enum in
  `schemas/team-shard.schema.json` and `OUTCOME_SOURCES` was widened to
  `claude | copilot | copilot-cli` without a contract version change. This
  matters most for proposal 15: sessions hosted through Run are stored as
  Copilot CLI sessions, and would otherwise have been invisible to the team.
  From the first tagged release that reads shards, adding a source is a schema
  version bump.
