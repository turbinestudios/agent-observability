# Privacy Validation: Checklist & Enforcement

This document states the **overall privacy guarantee** of Agent Observability
and lists exactly **how each part is enforced and tested** in code. It is the
reference for a privacy audit.

## End-to-end guarantee

> **No raw prompt, response, tool I/O, reasoning, hook, or session content, and
> no source-file paths, file contents, commit hashes, branch names, machine
> name, OS username, or developer email, ever reaches the cloud.** Raw content
> is readable **only locally** inside the VS Code extension. The cloud receives
> **only** two strict batch contracts (the **aggregate batch** and the
> **context-insights batch**), and **only** after explicit, per-developer
> opt-in. Those batches go **only** to the dashboard address the user sets in
> `agentObservability.sync.dashboardUrl`, a user-settings-only, `https://`-only
> setting that is empty by default, so nothing uploads until the user sets it.
> The desktop app additionally offers an opt-in **team shard**: one JSON file
> per member, written only to a shared folder the user chose (no server),
> containing the same two batch contracts unchanged plus per-day,
> per-repository session-outcome counts (`schemas/team-shard.schema.json`). It
> is off by default, previewable byte for byte before sharing, and the app
> reads other members' shards only after validating them against the same
> rules the server applies. The single exception to "no paths" is deliberate and narrow: the
> context-insights batch carries the **repository-relative paths of
> customization files only** (instructions/skills/prompts/agents/hooks), with
> counts and never contents, so teams can review context-engineering hotspots.
> Three further deliberate, narrow exceptions exist for **content**, all
> confined to the desktop app and to the user's own local AI CLI login:
> Claude Code (`claude`, to Anthropic) or the GitHub Copilot CLI (`copilot`,
> to GitHub), whichever backend Settings selects; never an API key of this
> product. All three are only ever user-initiated and never background, and
> all are entirely independent of the aggregate/context-insights upload paths, which
> never carry raw content. The opt-in **Deep Retrospective** sends one
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
> host (Run)**: when the user turns it on in Settings (off by default) and has
> acknowledged a one-time notice, it starts and continues GitHub Copilot
> sessions through the Copilot SDK on the user's own installed `copilot` and
> their own Copilot login. A hosted session sends the user's message, and what
> the agent then reads, to GitHub exactly as running `copilot` does; every
> action the agent wants to take is shown to the user and waits for their
> answer; nothing runs in the background; and nothing about it enters the
> aggregate, sync or team paths. Claude Code is never driven by the app.
> Applying a plan is the product's one sanctioned **local write path**:
> allowlisted context files under the plan's re-verified repository root
> only, per-file approved after a diff preview, staleness-checked against the
> generation, backed up before writing, never deleting.

The guarantee is enforced by **defense in depth**: the client never emits raw
fields, the shared schema rejects unexpected fields, and the server re-validates
and rejects raw/free-text fields even though it does not trust the client.

## Privacy checklist (and where it is enforced)

| # | Control | Where enforced | How it is tested |
|---|---------|----------------|------------------|
| 1 | Extension reads only **safe metadata** for aggregation; raw content is shown **locally only** | `src/extension/.../telemetry/database.ts` (typed safe-metadata queries; the single raw-content read feeds only the local session-detail view) | `telemetry/safety.test.ts`, `telemetry/sessionDetail.test.ts` |
| 2 | Local DB opened **read-only**: extension on a snapshot, desktop in a short-lived native read transaction; source never mutated | core `telemetry/snapshot.ts`, `telemetry/database.ts`; desktop `datahost/drivers/nativeTelemetryBackend.ts` | core `telemetry/safety.test.ts`; desktop `datahost/drivers/nativeTelemetryBackend.test.ts` (writes throw, source unchanged, snapshot parity, WAL readers released) |
| 3 | Aggregate batch contains **no raw-content markers**, no redaction placeholder, no email-shaped string, no `@` in repositories | `aggregate/aggregator.ts` (+ `pseudonymizer.ts`, `repositoryUrl.ts`) | `aggregate/privacy.test.ts` (real fixture, scans every string) |
| 4 | Aggregate batch validates against the strict shared schema: `additionalProperties:false`, so unexpected/raw fields are rejected | `schemas/aggregate-batch.schema.json` (shared contract) | `aggregate/privacy.test.ts` test (1) compiles with ajv 2020 `strict:true` and validates |
| 5 | Repository is `unknown` or a sanitized `https?://host/path` URL, with no credentials/PII | `telemetry/repositoryUrl.ts` (`REPOSITORY_PATTERN`) + schema pattern | `aggregate/privacy.test.ts` tests (2),(3); `telemetry/repositoryUrl.test.ts` |
| 6 | Developer id is **pseudonymous** (`dev_[0-9a-f]{32}`), salted, irreversible | `aggregate/pseudonymizer.ts`, `secrets/pseudonymize.ts` | `aggregate/privacy.test.ts` test (4); `secrets/pseudonymize.test.ts` |
| 7 | `repositoryBranch` is **omitted by default** and length/charset-capped when present | extension aggregator; server `AggregateBatchValidator` | `aggregate/privacy.test.ts` (branch marker absent); server `ValidatorTests` |
| 8 | Sharing is **opt-in, off by default**; sync blocked unless consent **and** key present | `consent/consentManager.ts`, `consent/syncGate.ts`, package `agentObservability.sync.enabled=false` | `consent/syncGate.test.ts`, `consent/consentDisclosure.test.ts` |
| 9 | API key stored **only** in SecretStorage; never in settings/files/logs | `secrets/secretManager.ts` | `secrets/*` tests; see `docs/architecture/api-auth.md` §2 |
| 10 | Server re-validates the batch and **rejects raw/free-text fields** (defense in depth) | `Services/Ingestion/AggregateBatchValidator.cs` | `ValidatorTests.cs`, `IngestionPipelineTests.cs` |
| 11 | `orgId` derived from the **key record**, never the payload | `Services/Ingestion/IngestionAuthenticator.cs` | `IngestionPipelineTests.cs` |
| 12 | Dashboard exposes **no raw-telemetry query or polling surface**: AI/KQL widget queries and cloud-side deviation polling were removed; it renders only aggregate analytics from Table Storage | `Services/Analytics/AggregateAnalyticsService.cs` (sole analytics path) | `AggregateAnalyticsServiceTests.cs` |
| 13 | **Context-insights** batch carries customization-file paths **only** (allowlisted, repo-relative, no `..`/drive/`@`), never source/doc paths or contents | extension `aggregate/customizationFilter.ts` (`SAFE_CONTEXT_FILE_PATTERN`, repo-scoped resolver) + `schemas/context-insights-batch.schema.json` | `aggregate/contextInsightsPrivacy.test.ts` (adversarial inputs; scans every string) |
| 14 | Skip reasons reduced to a **closed taxonomy** (`applyToNoMatch`/`other`); raw reason text never transmitted | `aggregate/contextInsightsExtractor.ts` (`classifySkipReason`) | `aggregate/contextInsightsPrivacy.test.ts` (raw reason absent) |
| 15 | Server re-validates the context-insights batch and **rejects absolute/traversal/non-allowlisted paths** and unknown fields | `Services/Ingestion/ContextInsightsBatchValidator.cs` | `ContextInsightsValidatorTests.cs`, `ContextInsightsIngestionTests.cs` |
| 16 | **Copilot (Cloud)** source is **pull-only**: raw cloud prompts / tool I/O / assistant text land on **local disk only** (home-dir sink) and the source uploads **nothing**: `getAggregationRows` returns `[]` | `src/cloud/cloudSink.ts` (local sink), `src/cloud/copilotCloudSource.ts` (`getAggregationRows` → `[]`) | `src/cloud/copilotCloudSource.test.ts` (`getAggregationRows returns []` test) |
| 17 | **Context Improvement Plans** are double-gated (default-off setting + per-generation dialog naming vendor and payload) and the data host refuses a gate-off call **before** anything is assembled or sent | desktop `datahost/improve/contextPlan.ts` (`IMPROVE_ENABLED_KEY` check first) | `datahost/improve/contextPlan.test.ts` ("gate off … CLI seam is never touched") |
| 18 | The plan **write path** is constrained to `SAFE_CONTEXT_FILE_PATTERN` files under the plan's re-verified repo root: traversal refused, staleness-checked (sha256 against generation), backed up before writing, **no delete action exists** | desktop `datahost/improve/contextPlanApply.ts` (allowlist re-check, `path.relative` guard, backup-then-write) | `datahost/improve/contextPlanApply.test.ts` (tampered path, moved root, stale, undo, never-delete) |
| 19 | Batches go **only** to the user-set dashboard address: `agentObservability.sync.dashboardUrl` is `application`-scoped (user settings only, so a workspace or folder setting cannot redirect the API key), **empty by default**, and **`https://` only**; any other value counts as unset, and sync reports "misconfigured" and uploads nothing | extension `package.json` (`"scope": "application"`, `https://`-or-empty pattern); core `config/configuration.ts` (`normalizeDashboardUrl`), `sync/syncClient.ts` | `config/configuration.test.ts`; `sync/syncClient.test.ts` ("missing dashboard URL -> misconfigured (no POST attempted)"); `sync/syncEngine.test.ts` |
| 20 | **Team shard** carries only the aggregate batch, the context-insights batch (unchanged builders) and closed-set outcome counts; `additionalProperties:false` at every level; the two batch schemas are embedded by `$ref`, never copied | core `team/teamShardBuilder.ts`, `schemas/team-shard.schema.json` | core `team/teamShardPrivacy.test.ts` (ajv 2020 `strict:true`; scans every string for raw markers, `@`, paths, a planted title) |
| 21 | Team export is **opt-in, off by default**, gated by the disclosure dialog **and** re-checked in the data host (toggle + recorded consent time) before anything is assembled; the shard is validated before it is written; a hand-edited `true` alone does not share | desktop `datahost/team/teamExport.ts` (`teamSharingOn` first), `datahost/settings.ts` (`team.consentedAtMs`) | `datahost/team/teamExport.test.ts` ("refuses before gathering anything"), `datahost/settings.test.ts` ("does not read a hand-edited true as consent") |
| 22 | Imported shards are re-validated with the TypeScript ports of the server validators (unknown keys, repository/path/id patterns, enums, partition invariants); unknown `schemaVersion`, oversized, malformed or mis-named files are **skipped with a notice**, never merged | core `aggregate/batchValidators.ts`, `team/teamShardValidator.ts`, `team/teamMerge.ts`; desktop `datahost/team/teamFolder.ts` | `aggregate/batchValidators.test.ts` (parity with ajv), `team/teamShardValidator.test.ts`, `team/teamMerge.test.ts`, `datahost/team/teamFolder.test.ts` |
| 23 | The desktop pseudonym salt lives in its own file (`~/.agent-observability/desktop/team-salt`, 0600 where honoured), never in `config.json`, never in a shard or the shared folder | desktop `datahost/team/teamSalt.ts` | `datahost/team/teamSalt.test.ts` |
| 24 | Desktop context-insights rows pass the same `SAFE_CONTEXT_FILE_PATTERN` gate as the extension's: absolute `context_files` paths are made repo-relative under a re-verified checkout root or **dropped** (user-level `~/.claude/CLAUDE.md` never leaves) | desktop `datahost/team/teamShardSource.ts` + core `aggregate/customizationFilter.ts` | `datahost/team/teamExport.test.ts` ("drops files outside the checkout and off the allowlist") |
| 25 | **Run is off by default** and double-gated (Settings toggle + a one-time notice recorded only by its own acknowledge call); the data host refuses every action that starts, continues or approves while off or unacknowledged, and never accepts a working directory from the renderer | desktop `datahost/run/runService.ts` (`gate`, verified checkout or the session's own record), `datahost/run/runController.ts`, `datahost/settings.ts` (`run.enabled`; `run.disclosed` not patchable) | `datahost/run/runService.test.ts` ("refuses every action while Run is off…", "starts in the directory it resolved itself…"), `datahost/settings.test.ts` ("Run settings") |
| 26 | **Ask is the only permission posture** for hosted sessions: allow once, allow for this session, or deny; no persistent approval, no allow-all; pending requests are answered "user not available" on stop, close and quit | desktop `datahost/run/sdkDriver.ts`, `runController.ts` | `datahost/run/runSafety.test.ts` (source scan: no `approveAll`, `allow-all`, `approve-permanently`, `approve-for-location`), `runController.test.ts`; opt-in `runSmoke.test.ts` against the real CLI (a denied write creates no file) |
| 27 | The app **ships no Copilot runtime**: it drives the user's installed CLI, and the installers exclude the SDK's bundled runtime packages | desktop `datahost/run/runtimePath.ts`, `electron-builder.yml` | `datahost/run/runtimePath.test.ts`, `runSafety.test.ts` (packaging assertions) |
| 28 | The run host is **separate from sharing**: no import from `aggregate/*`, `sync/*` or `team/*`; a hosted session reaches the index only as an ordinary Copilot CLI session | desktop `datahost/run/*` | `datahost/run/runService.test.ts` ("imports nothing from aggregate, sync or team") |

## Client-side enforcement (VS Code extension)

The extension reads the on-disk Copilot SQLite database **read-only**. Almost
all queries select only **typed, safe-metadata** columns (timestamps, counts,
model ids, status codes, durations, session keys). Raw content is read by a
**single** query path that feeds **only** the local session-detail view and is
never aggregated or uploaded.

The aggregate engine (`aggregate/aggregator.ts`) emits **only** the fields of the
shared contract: counts, token totals, a fixed-bounds latency histogram, and the
closed-set dimensions (repo / model / agentMode / operation / optional toolName),
keyed by a pseudonymous developer id. The forbidden raw-content attribute keys
(authoritative list in
[`docs/architecture/aggregate-payload-schema-v1.md`](architecture/aggregate-payload-schema-v1.md)
§7) are never copied into a batch.

### The Copilot (Cloud) source: pull-based, local-only

The **Copilot (Cloud)** source *pulls* GitHub Copilot cloud coding-agent
sessions **down** from the GitHub API into a local sink under the home directory
(`src/cloud/cloudSink.ts`) and renders them like any other session. Like the
local Copilot content read, the sink stores **raw prompts, tool input/output,
and assistant text on local disk only**, the same sensitivity class as
Copilot's local `span_attributes`. This source uploads **nothing**: its
`getAggregationRows` returns `[]`, so nothing cloud-agent-related enters the
aggregate batch. Enforced in `src/cloud/copilotCloudSource.ts` and locked by
the **`getAggregationRows returns []`** test in
`src/cloud/copilotCloudSource.test.ts`.

One nuance is inherent to pulling org-visible data down rather than reading only
your own machine: with `agentObservability.copilotCloud.scope` set to `'repos'`,
the source also fetches the workspace repositories' tasks, so a user can see
**teammates' prompts locally**. This is exactly the same access control github.com
already grants that user, and still nothing is uploaded. The default scope
`'my-tasks'` keeps it **personal** (only the authenticated user's own tasks).

### The critical regression test: `aggregate/privacy.test.ts`

This test builds a **real** aggregate batch from real fixture telemetry (the same
read path the extension uses) and proves the whole contract:

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

## Shared contract: `schemas/aggregate-batch.schema.json`

The single shared contract between the TypeScript producer (extension) and the
C# consumer (dashboard API). It sets **`additionalProperties: false` at every
object level**, so the API rejects any unexpected (potentially raw/sensitive)
field. It constrains the dimension grain (30-minute buckets, fixed latency
bounds `[100,250,500,1000,2000,5000,10000,30000]`), the repository pattern, the
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

## Server-side enforcement (dashboard)

**The client is never trusted.** Even though the extension produces schema-valid
batches, the server re-checks every rule as defense in depth.

### `AggregateBatchValidator`

Located at
`src/dashboard/AgentObservability.Dashboard/Services/Ingestion/AggregateBatchValidator.cs`.
Re-validates a deserialized batch and rejects (400) on any problem. Key guards:

- **Repository `@`/`?`/`#`/whitespace rejection**: belt-and-suspenders so a
  producer sanitization mistake cannot leak a PAT/credential or free text to
  storage; repository must be `unknown` or a sanitized `https?://host/path` URL.
- **`agentMode`** restricted to the closed set `default|ask|edit|agent|custom`
  (the server does not trust the client to have mapped unknown modes to
  `custom`).
- **`operation`** restricted to `chat|execute_tool|execute_hook|invoke_agent`.
- **`toolName`** (optional) must be a bare identifier (`[A-Za-z0-9_-]`), not free
  text that could embed a path/customer id.
- **`model`** restricted to `[A-Za-z0-9._:/-]` (no whitespace, no `@`).
- **`repositoryBranch`** (optional, omitted by default, privacy-sensitive) capped
  in length and restricted to git-ref-safe chars when present.
- Schema version, bucket duration (`1800`s), pseudonymous-id pattern, fixed
  histogram bounds/length, and non-negative / partition (`success+error <=
  interaction`) measure invariants.

### `ContextInsightsBatchValidator`

Located at
`src/dashboard/AgentObservability.Dashboard/Services/Ingestion/ContextInsightsBatchValidator.cs`.
Re-validates the context-insights batch and rejects (400) on any problem. Its
most important guard is `ValidateContextFile`, which **independently** rejects
any `contextFile` that is not a repo-relative, allowlisted customization path.
It runs explicit pre-checks for `\`, `:`, leading `/`, `..`, `@`, `?`, `#`, and
whitespace **before** the allowlist regex, so an absolute path, home directory,
drive letter, traversal, or non-customization (source/doc) file can never reach
storage. It also re-checks the repository, developer-id, category, and bucket
duration, and that `skipReasonCounts` are non-negative and sum to `<=
skippedCount`. Tested by `ContextInsightsValidatorTests.cs` and
`ContextInsightsIngestionTests.cs`.

### `IngestionAuthenticator`

`orgId` is resolved from the validated **key record**, never from the request
body, so a Team-A key cannot write aggregates attributed to Team-B. Validation
uses `HMAC-SHA256(pepper, secret)` with a constant-time compare and an
indistinguishable-failure (dummy-HMAC) path. See
[`docs/architecture/api-auth.md`](architecture/api-auth.md).

### Aggregate-only dashboard (no raw-query surface)

The dashboard has **no raw-telemetry query path at all**. The legacy
`WidgetQueryService` (custom KQL widgets), `KqlGenerationService` /
`AiAssistantPanel` (AI-assisted query), and the cloud-side `AlertEngine`
(raw `AppDependencies/Properties[...]` deviation polling) were **deleted** in the
aggregate-only cleanup, along with the `WebUx:ExposeRawSessionDetail`,
`Analytics:Source`, `Analytics:FallbackToLegacyWhenEmpty`, and `AiQuery:Enabled`
flags that gated them. Analytics are served **exclusively** by
`AggregateAnalyticsService` reading the Azure Table Storage aggregate store, so
there is no execution surface that could touch raw telemetry. Workflow-deviation
detection runs **locally** in the extension.

## Rollback note

There is no runtime rollback to raw behavior: the raw-query/alert code paths and
their config flags no longer exist. Restoring legacy raw analytics requires
redeploying a pre-cleanup `infra/` + dashboard image tag. Under the current
configuration the guarantee above holds by construction: no raw prompt/response/session
content reaches the cloud.
