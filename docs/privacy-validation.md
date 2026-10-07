# Privacy Validation: Checklist & Enforcement

This document states the **overall privacy guarantee** of Agent Observability
and lists exactly **how each part is enforced and tested** in code. It is the
reference for a privacy audit.

## End-to-end guarantee

> **No raw prompt, response, tool I/O, reasoning, hook, or session content, and
> no source-file paths, file contents, commit hashes, branch names, machine
> name, OS username, or developer email, ever leaves the machine.** Raw
> content is readable **only locally** inside the desktop app. The only
> artifact the product itself writes for anyone else is the opt-in **team
> shard**: one JSON file per member, written only to a shared folder the user
> chose (there is no server), defined by `schemas/team-shard.schema.json`. It
> embeds the two strict batch contracts unchanged (the **aggregate batch** and
> the **context-insights batch**) plus per-day, per-repository
> session-outcome counts. It is off by default, previewable byte for byte
> before sharing, and the app reads other members' shards only after
> validating them against the same rules it applies before writing its own.
> The single exception to "no paths"
> is deliberate and narrow: the context-insights batch carries the
> **repository-relative paths of customization files only**
> (instructions/skills/prompts/agents/hooks), with counts and never contents,
> so teams can review context-engineering hotspots.
> Three further deliberate, narrow exceptions exist for **content**, all
> confined to the desktop app and to the user's own local AI CLI login:
> Claude Code (`claude`, to Anthropic) or the GitHub Copilot CLI (`copilot`,
> to GitHub), whichever backend Settings selects; never an API key of this
> product. All three are only ever user-initiated and never background, and
> all are entirely independent of the team shard, which never carries raw
> content. The opt-in **Deep Retrospective** sends one
> session's transcript digest to the selected vendor, only after the user
> enables it in Settings (off by default) **and** confirms a per-session
> dialog naming exactly what is sent. The **AI Helper** chat sends each
> message the user explicitly submits (their question, a summary of recent
> sessions with titles, repositories, verdicts, token and cost figures, and,
> when the user attaches a session, capped excerpts of its prompts and
> responses) after a one-time first-use notice in the view naming exactly
> that, enforced again in the data host. The opt-in **Context Improvement
> Plan** sends the selected context files' usage statistics, the selected
> sessions' retrospective evidence (titles and goals included), and the
> repository's context-file contents (capped), only after the user enables
> it in Settings (off by default) **and** confirms a per-generation dialog
> naming the vendor and that payload, enforced again in the data host.
> Separately from those exceptions, the desktop app can act as an **agent
> host (Run)**: while Run is on in Settings and once the user has
> acknowledged a one-time notice, it starts and continues GitHub Copilot
> sessions through the Copilot SDK on the user's own installed `copilot` and
> their own Copilot login. A hosted session sends the user's message, and what
> the agent then reads, to GitHub exactly as running `copilot` does; every
> action the agent wants to take is shown to the user and waits for their
> answer unless the user chose Allow all for that one session; nothing runs in
> the background; and nothing about it enters the aggregate or team paths.
> Claude Code is never driven by the app.
> Applying a plan is the product's one sanctioned **local write path**:
> allowlisted context files under the plan's re-verified repository root
> only, per-file approved after a diff preview, staleness-checked against the
> generation, backed up before writing, never deleting.

The guarantee is enforced by **defense in depth**: the producer never emits raw
fields, the shared schemas reject unexpected fields, and the TypeScript
validators re-check every shard (before it is written and again when a
teammate's shard is read) and reject raw/free-text fields even though they do
not trust the producer.

## Privacy checklist (and where it is enforced)

| # | Control | Where enforced | How it is tested |
|---|---------|----------------|------------------|
| 1 | Session reads take only **safe metadata** for aggregation; raw content is shown **locally only** | core `telemetry/database.ts` (typed safe-metadata queries; the single raw-content read feeds only the local session-detail view) | `telemetry/safety.test.ts`, `telemetry/sessionDetail.test.ts` |
| 2 | Local DB opened **read-only**: core on a snapshot, desktop in a short-lived native read transaction; source never mutated | core `telemetry/snapshot.ts`, `telemetry/database.ts`; desktop `datahost/drivers/nativeTelemetryBackend.ts` | core `telemetry/safety.test.ts`; desktop `datahost/drivers/nativeTelemetryBackend.test.ts` (writes throw, source unchanged, snapshot parity, WAL readers released) |
| 3 | Aggregate batch contains **no raw-content markers**, no redaction placeholder, no email-shaped string, no `@` in repositories | core `aggregate/aggregator.ts` (+ `aggregate/pseudonymizer.ts`, `telemetry/repositoryUrl.ts`) | `aggregate/privacy.test.ts` (real fixture, scans every string) |
| 4 | Aggregate batch validates against the strict shared schema: `additionalProperties:false`, so unexpected/raw fields are rejected | `schemas/aggregate-batch.schema.json` (shared contract) | `aggregate/privacy.test.ts` test (1) compiles with ajv 2020 `strict:true` and validates |
| 5 | Repository is `unknown` or a sanitized `https?://host/path` URL, with no credentials/PII | `telemetry/repositoryUrl.ts` (`REPOSITORY_PATTERN`) + schema pattern | `aggregate/privacy.test.ts` tests (2),(3); `telemetry/repositoryUrl.test.ts` |
| 6 | Developer id is **pseudonymous** (`dev_[0-9a-f]{32}`), salted, irreversible | `aggregate/pseudonymizer.ts`, `secrets/pseudonymize.ts` | `aggregate/privacy.test.ts` test (4); `secrets/pseudonymize.test.ts` |
| 7 | `repositoryBranch` is **never emitted** by the aggregator, and is length/charset-capped by the validator if a batch carries one | core `aggregate/aggregator.ts`, `aggregate/batchValidators.ts` | `aggregate/privacy.test.ts` (branch marker absent); `aggregate/batchValidators.test.ts` |
| 8 | The TypeScript validator re-checks the aggregate batch and **rejects raw/free-text fields** the schema alone cannot catch (defense in depth) | core `aggregate/batchValidators.ts` (`validateAggregateBatch`) | `aggregate/batchValidators.test.ts` (parity with ajv, plus rules the schema cannot express) |
| 9 | **Context-insights** batch carries customization-file paths **only** (allowlisted, repo-relative, no `..`/drive/`@`), never source/doc paths or contents | core `aggregate/customizationFilter.ts` (`SAFE_CONTEXT_FILE_PATTERN`, repo-scoped resolver) + `schemas/context-insights-batch.schema.json` | `aggregate/contextInsightsPrivacy.test.ts` (adversarial inputs; scans every string) |
| 10 | Skip reasons reduced to a **closed taxonomy** (`applyToNoMatch`/`other`); raw reason text never written | core `aggregate/contextInsightsExtractor.ts` (`classifySkipReason`) | `aggregate/contextInsightsPrivacy.test.ts` (raw reason absent) |
| 11 | The TypeScript validator re-checks the context-insights batch and **rejects absolute/traversal/non-allowlisted paths** and unknown fields | core `aggregate/batchValidators.ts` (`validateContextInsightsBatch`) | `aggregate/batchValidators.test.ts` |
| 12 | **Context Improvement Plans** are double-gated (default-off setting + per-generation dialog naming vendor and payload) and the data host refuses a gate-off call **before** anything is assembled or sent | desktop `datahost/improve/contextPlan.ts` (`IMPROVE_ENABLED_KEY` check first) | `datahost/improve/contextPlan.test.ts` ("gate off … CLI seam is never touched") |
| 13 | The plan **write path** is constrained to `SAFE_CONTEXT_FILE_PATTERN` files under the plan's re-verified repo root: traversal refused, staleness-checked (sha256 against generation), backed up before writing, **no delete action exists** | desktop `datahost/improve/contextPlanApply.ts` (allowlist re-check, `path.relative` guard, backup-then-write) | `datahost/improve/contextPlanApply.test.ts` (tampered path, moved root, stale, undo, never-delete) |
| 14 | **Team shard** carries only the aggregate batch, the context-insights batch (unchanged builders) and closed-set outcome counts; `additionalProperties:false` at every level; the two batch schemas are embedded by `$ref`, never copied | core `team/teamShardBuilder.ts`, `schemas/team-shard.schema.json` | core `team/teamShardPrivacy.test.ts` (ajv 2020 `strict:true`; scans every string for raw markers, `@`, paths, a planted title) |
| 15 | Team export is **opt-in, off by default**, gated by the disclosure dialog **and** re-checked in the data host (toggle + recorded consent time) before anything is assembled; the shard is validated before it is written; a hand-edited `true` alone does not share | desktop `datahost/team/teamExport.ts` (`teamSharingOn` first), `datahost/settings.ts` (`team.consentedAtMs`) | `datahost/team/teamExport.test.ts` ("refuses before gathering anything"), `datahost/settings.test.ts` ("does not read a hand-edited true as consent") |
| 16 | Imported shards are re-validated with the TypeScript validators (unknown keys, repository/path/id patterns, enums, partition invariants); unknown `schemaVersion`, oversized, malformed or mis-named files are **skipped with a notice**, never merged | core `aggregate/batchValidators.ts`, `team/teamShardValidator.ts`, `team/teamMerge.ts`; desktop `datahost/team/teamFolder.ts` | `aggregate/batchValidators.test.ts` (parity with ajv), `team/teamShardValidator.test.ts`, `team/teamMerge.test.ts`, `datahost/team/teamFolder.test.ts` |
| 17 | The desktop pseudonym salt lives in its own file (`~/.agent-observability/desktop/team-salt`, 0600 where honoured), never in `config.json`, never in a shard or the shared folder | desktop `datahost/team/teamSalt.ts` | `datahost/team/teamSalt.test.ts` |
| 18 | Desktop context-insights rows pass the `SAFE_CONTEXT_FILE_PATTERN` gate: absolute `context_files` paths are made repo-relative under a re-verified checkout root or **dropped** (user-level `~/.claude/CLAUDE.md` never leaves) | desktop `datahost/team/teamShardSource.ts` + core `aggregate/customizationFilter.ts` | `datahost/team/teamExport.test.ts` ("drops files outside the checkout and off the allowlist") |
| 19 | **Run is double-gated**: a Settings toggle (on by default, so the view shows; turning it off hides it) **and** a one-time notice recorded only by its own acknowledge call, which a new install has not given; the data host refuses every action that starts, continues or approves while off or unacknowledged, and never accepts a working directory from the renderer | desktop `datahost/run/runService.ts` (`gate`, verified checkout or the session's own record), `datahost/run/runController.ts`, `datahost/settings.ts` (`run.enabled`; `run.disclosed` not patchable) | `datahost/run/runService.test.ts` ("refuses every action while Run is off…", "starts in the directory it resolved itself…"), `datahost/settings.test.ts` ("Run settings") |
| 20 | **Asking is the default for hosted sessions, and every approval is the user's and ends with the session**: allow once, allow for this session (scoped to what the request is about), or deny; **Allow all** only as the user's per-session choice behind a confirmation: the CLI's own allow-all mode switched on for that one session through the SDK, in memory, never a setting, counted only once the runtime has taken it, ended when the session loses its CLI, never turned on while Run is off; no persistent approval, no process-wide `--allow-all` flag or environment variable, no SDK approve-everything handler; pending requests are answered "user not available" on stop, close and quit | desktop `datahost/run/sdkDriver.ts` (`setAllowAll`), `runController.ts`, `permissionScope.ts` | `datahost/run/runSafety.test.ts` (source scan: no `approveAll` handler, no `--allow-all` argument, no `COPILOT_ALLOW_ALL`, no `approve-permanently` or `approve-for-location`; the runtime mode is set in exactly one driver method, called from exactly one place), `runController.test.ts` (queue, session scope, Allow all: on, refused, back, lost with the CLI, off while Run is off), `sdkDriver.test.ts`, `permissionScope.test.ts`; opt-in `runSmoke.test.ts` against the real CLI (a denied write creates no file) |
| 21 | The app **ships no Copilot runtime**: it drives the user's installed CLI, and the installers exclude the SDK's bundled runtime packages | desktop `datahost/run/runtimePath.ts`, `electron-builder.yml` | `datahost/run/runtimePath.test.ts`, `runSafety.test.ts` (packaging assertions) |
| 22 | The run host is **separate from sharing**: no import from `aggregate/*` or `team/*`; a hosted session reaches the index only as an ordinary Copilot CLI session | desktop `datahost/run/*` | `datahost/run/runService.test.ts` ("imports nothing from aggregate, sync or team") |
| 23 | The Copilot runtime's `session-store.db` is read **only as a snapshot copy**, and only its numeric usage columns and model id: never `turns`, `forge_trajectory_events`, `search_index` or `token_details_json` | core `copilotCli/sessionStoreUsage.ts` | `copilotCli/copilotApp.test.ts` ("reads per-session, per-model sums from a live WAL-mode store without touching it": a planted text column never surfaces, the source's mtime is unchanged) |
| 24 | **Copilot app** sessions enter a team shard only under the existing `copilot-cli` source, so the shard's closed source set and schema are unchanged; **Copilot (JetBrains)** sessions are not shared at all | desktop `datahost/team/teamShardSource.ts` (`shardSource`, the `OUTCOME_SOURCES` filter) | `datahost/indexer/copilotAppIndexer.test.ts` ("is shared in a team shard as a Copilot CLI session") |
| 25 | The Copilot JetBrains plugin's chat stores are **read whole into memory and never opened for writing**; the probe script prints structure only (counts, record names, header bytes), never prompts, replies, titles, project names or account-named folders | core `copilotJetbrains/copilotJetbrainsSource.ts`, desktop `scripts/jetbrainsProbe.ts` | `copilotJetbrains/copilotJetbrains.test.ts` (side records never surface; a locked store is reported, not failed) |

## Local enforcement (desktop app and core)

The app reads the on-disk Copilot SQLite database **read-only**. Almost all
queries select only **typed, safe-metadata** columns (timestamps, counts,
model ids, status codes, durations, session keys). Raw content is read by a
**single** query path that feeds **only** the local session-detail view and is
never aggregated or shared. The app also reads the durable Copilot archive
under `~/.agent-observability` that earlier versions of the VS Code extension
wrote; nothing writes that archive any more.

The aggregate engine (`aggregate/aggregator.ts`) emits **only** the fields of the
shared contract: counts, token totals, a fixed-bounds latency histogram, and the
closed-set dimensions (repo / model / agentMode / operation / optional toolName),
keyed by a pseudonymous developer id. The forbidden raw-content attribute keys
(authoritative list in
[`docs/architecture/aggregate-payload-schema-v1.md`](architecture/aggregate-payload-schema-v1.md)
§7) are never copied into a batch.

### The critical regression test: `aggregate/privacy.test.ts`

This test builds a **real** aggregate batch from real fixture telemetry (the same
read path the app uses) and proves the whole contract:

1. The batch validates against the strict shared JSON Schema via **ajv 2020**
   (`strict:true`), proving `additionalProperties:false` holds, so no
   unexpected/raw field can leak.
2. No string anywhere in the batch contains any of the **16 forbidden markers**
   (the 12 raw-content attribute keys plus borderline/identifying fields such as
   `copilot_chat.repo.head_branch_name`, `head_commit_hash`,
   `request.options`, and `repositoryBranch`), no redaction placeholder, no
   email-shaped string, and no `@` in any repository.
3. Every repository matches the schema repository pattern.
4. `pseudonymousDeveloperId` matches `^dev_[0-9a-f]{32}$`.
5. `operation` is one of the four enum values.
6. Re-building from the same rows is idempotent (identical `batchId`/`rowKeys`).

### The context-insights regression test: `aggregate/contextInsightsPrivacy.test.ts`

This test drives the **real producer pipeline** (build repo customization index →
extract observations → aggregate batch) with a deliberately **adversarial** mix
of inputs (absolute/global-scope prompt paths, `..` traversal, ambiguous names,
non-allowlisted files, and a skip event whose raw reason embeds a username and
absolute path) and proves that:

1. The batch validates against `schemas/context-insights-batch.schema.json` via
   **ajv 2020** (`strict:true`): `additionalProperties:false` holds.
2. **Only** safe, in-repo, allowlisted customization paths survive; every
   adversarial input is dropped.
3. No string in the batch contains an absolute path, drive letter, `..`, `@`,
   backslash, email shape, the workspace/home directory, a username, or the raw
   skip-reason text.
4. Every `contextFile` matches the allowlisted repo-relative path pattern, every
   repository the repository pattern; the developer id is pseudonymous,
   categories are enum-only, and skip-reason keys are the closed set.
5. Re-building from the same observations is idempotent (identical
   `batchId`/`rowKeys`).

### The team-shard regression test: `team/teamShardPrivacy.test.ts`

This test builds a shard with the real builders and proves that:

1. The shard validates against `schemas/team-shard.schema.json` via **ajv
   2020** (`strict:true`), with the two embedded contracts resolved by `$ref`.
2. No string in the shard contains a raw-content marker, an email shape, `@`,
   a backslash, a drive letter, the home directory, or a planted session
   title.
3. Every repository and `contextFile` matches the contracts, and the developer
   ids are pseudonymous and equal across the three parts.
4. Rebuilding is byte-identical apart from the `generatedAt` stamps.
5. The importer-side TypeScript validator accepts it.

## Shared contract: `schemas/aggregate-batch.schema.json`

The contract between core's aggregator, which produces the batch, and the
validators that check every shard before it is written or merged. It sets
**`additionalProperties: false` at every object level**, so any unexpected
(potentially raw/sensitive) field is rejected. It constrains the dimension
grain (30-minute buckets, fixed latency bounds
`[100,250,500,1000,2000,5000,10000,30000]`), the repository pattern, the
`dev_[0-9a-f]{32}` developer id, and the operation enum.

## Second shared contract: `schemas/context-insights-batch.schema.json`

An **additive, separate** contract (not a version bump of the aggregate batch)
carrying per-(repository, customization-file, category) hotspot rows at the same
30-minute grain. It is the **only** contract that conveys file paths, so it
constrains `contextFile` to a repo-relative POSIX path with **no `..`, drive
letter, leading `/`, backslash, `@`, `?`, `#`, or whitespace** that **must** end
in an allowlisted customization suffix (`*.instructions.md`, `*.prompt.md`,
`*.agent.md`, `*.skill.md`) or a known root/skill file (`copilot-instructions.md`,
`AGENTS.md`, `CLAUDE.md`, `SKILL.md`). It sets `additionalProperties:false` at
every level, reuses the repository and `dev_[0-9a-f]{32}` patterns, fixes the
category enum (`instruction|skill|agent|hook|prompt`), and restricts skip
reasons to the closed `{applyToNoMatch, other}` set. File **contents** are never
read; token size is estimated from file **size** only.

## Third shared contract: `schemas/team-shard.schema.json`

The file the desktop app writes to the team folder. It wraps the two batch
contracts above, embedded by `$ref` and never copied or extended, in an
envelope (schema version, generation time, tool version, pseudonymous
developer id, window) and adds an `outcomes` block of per-day,
per-repository session counts, verdict mix and estimated cost over closed
source and verdict sets. It sets `additionalProperties:false` at every level.

## Validation on write and on read (defense in depth)

**The producer is never trusted.** Each shard is checked before the app writes
it, and every shard read from the team folder, which other machines write, is
checked again before it is merged. The schema alone cannot express every rule,
so core carries TypeScript validators that re-check them.

### `aggregate/batchValidators.ts`

`validateAggregateBatch` rejects the batch on any problem. Key guards:

- **Repository `@`/`?`/`#`/whitespace rejection**: belt-and-suspenders so a
  producer sanitization mistake cannot leak a PAT/credential or free text;
  repository must be `unknown` or a sanitized `https?://host/path` URL.
- **`agentMode`** restricted to the closed set `default|ask|edit|agent|custom`.
- **`operation`** restricted to `chat|execute_tool|execute_hook|invoke_agent`.
- **`toolName`** (optional) must be a bare identifier (`[A-Za-z0-9_-]`), not free
  text that could embed a path/customer id.
- **`model`** restricted to `[A-Za-z0-9._:/-]` (no whitespace, no `@`).
- **`repositoryBranch`** (never emitted, privacy-sensitive) capped in length
  and restricted to git-ref-safe chars if present.
- Schema version, bucket duration (`1800`s), pseudonymous-id pattern, fixed
  histogram bounds/length, and non-negative / partition (`success+error <=
  interaction`) measure invariants.

`validateContextInsightsBatch` **independently** rejects any `contextFile`
that is not a repo-relative, allowlisted customization path. It runs explicit
checks for `\`, `:`, leading `/`, `..`, `@`, `?`, `#`, and whitespace
**before** the allowlist regex, so an absolute path, home directory, drive
letter, traversal, or non-customization (source/doc) file is refused. It also
re-checks the repository, developer-id, category, and bucket duration, and
that `skipReasonCounts` are non-negative and sum to `<= skippedCount`.

Both are tested by `aggregate/batchValidators.test.ts`, which checks parity
with ajv and the rules the schema cannot express.

### `team/teamShardValidator.ts` and the team folder

`team/teamShardValidator.ts` checks the envelope and the `outcomes` block and
runs the two embedded batches through the validators above. The desktop's
`datahost/team/teamFolder.ts` skips oversized, malformed or mis-named files
and unknown schema versions with a visible notice; a shard that fails
validation is never partially merged. Tested by
`team/teamShardValidator.test.ts`, `team/teamMerge.test.ts` and desktop
`datahost/team/teamFolder.test.ts`.
