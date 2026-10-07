# Context-Insights Payload Schema v1

Status: Implemented. Producer: `src/core/agent-observability-core/src/aggregate/contextInsightsAggregator.ts`,
run by the desktop app's team export. Consumer: the desktop's team-shard importer, through
`src/core/agent-observability-core/src/team/teamShardValidator.ts` and
`src/core/agent-observability-core/src/aggregate/batchValidators.ts`.
Schema file: [`schemas/context-insights-batch.schema.json`](../../schemas/context-insights-batch.schema.json)
`schemaVersion`: `"1.0"`

This document is the human-readable companion to the strict JSON Schema (draft 2020-12) for the
**context-insights batch**. The batch travels only **embedded unchanged** in the desktop app's
**team shard** ([`schemas/team-shard.schema.json`](../../schemas/team-shard.schema.json)), a JSON
file written to a folder the user chose. Core's context-insights aggregator is the **producer**;
the team-shard importer in other members' apps is the **consumer**, and it validates every shard
before merging it. As with the aggregate-batch contract, the JSON Schema is the source of truth
and `"additionalProperties": false` at **every** object level is the privacy-enforcement mechanism.

It is a **separate** contract from [`aggregate-batch.schema.json`](../../schemas/aggregate-batch.schema.json):
the v1 aggregate batch is unchanged by it, so its privacy tests and invariants still hold. The
two batches are built in the same team export, share the same `pseudonymousDeveloperId`
derivation, window and 30-minute `bucketStart` alignment, and sit side by side in one shard.

---

## 1. Purpose

Let a Scrum team review, **per repository (project) and per sprint (time window)**, which Copilot
**customization files** (instructions / skills / prompts / agents / hooks) are "hotspots" worth
refining. Four signals are aggregated per file:

| Signal              | Measure(s)                                   | What it tells the retro                                  |
| ------------------- | -------------------------------------------- | -------------------------------------------------------- |
| Frequently skipped  | `skippedCount`, `skipReasonCounts`           | Misconfigured / wasted artifacts (e.g. `applyTo` misses) |
| Token-heavy         | `estTokensSum`, `estTokensMax`               | Context-budget pressure / oversized files                |
| Friction co-occurrence | `sessionsWithErrorCount`, `sessionsWithDeviationCount` | Files present when errors / workflow deviations occurred |
| Frequently applied  | `appliedCount`, `distinctSessionCount`       | High-impact files worth investing in                     |

The two friction measures are **co-occurrence only**: a file being present in a session that
errored or deviated is **not** a causal claim, and must not be presented as one.

---

## 2. The privacy boundary (what is new in this contract)

This is the only contract that conveys repo-relative file **paths** off the machine (into the
team folder). It is tightly scoped so the incremental disclosure is bounded and predictable:

- **Customization files only.** Source/doc files pulled into context (via `read_file`/attachments)
  are out of scope and **cannot** satisfy the `contextFile` pattern.
- **Repo-relative POSIX paths only.** The desktop resolves each repository back to a local
  checkout whose remote still sanitizes to the same repository
  (`src/desktop/agent-observability-desktop/src/datahost/improve/repoRoot.ts`) and emits each
  customization file's path relative to that root
  (`src/desktop/agent-observability-desktop/src/datahost/team/teamShardSource.ts`). Files that do
  not resolve inside the repo (user/global-scope customization files, e.g. a user-level
  `~/.claude/CLAUDE.md`), and every file in a repository that cannot be resolved, are **dropped**.
  This is how "repo-scoped only" is enforced.
- **The path pattern forbids**, structurally: a leading `/`, drive letters, backslashes, `..`
  segments (no traversal), and any character outside `[A-Za-z0-9_.-]` per segment (no whitespace,
  `@`, `?`, `#`, `:`). The filename MUST match an allowlist suffix
  (`*.instructions.md`, `*.prompt.md`, `*.agent.md`, `*.skill.md`) or a known root/skill file
  (`copilot-instructions.md`, `AGENTS.md`, `CLAUDE.md`, `SKILL.md`).
- **No file contents, ever.** Only the path plus integer counts and estimated-token weights travel.
- **No raw skip-reason text.** Free-text reasons are bucketed locally into the closed
  `skipReasonCounts` taxonomy (`applyToNoMatch`, `other`); `additionalProperties:false` rejects any
  other key.
- **No branches, no identities, no commit hashes.** Identity is the opaque `pseudonymousDeveloperId`
  only; `repository` is sanitized identically to the aggregate-batch contract.

Consent: this rides the team shard's opt-in. Team and team sharing are both **off by default**,
sharing is gated on a disclosure dialog, and the byte-exact preview of the shard states that the
only paths it carries are the repo-relative names of context files.
See [`pseudonymization-strategy.md`](pseudonymization-strategy.md) and
[`../privacy-validation.md`](../privacy-validation.md).

---

## 3. Envelope

One batch covers one contiguous UTC `window` for one developer.

| Field                     | Type            | Required | Notes                                                                                  |
| ------------------------- | --------------- | :------: | -------------------------------------------------------------------------------------- |
| `schemaVersion`           | string const    |   yes    | Always `"1.0"`. Independent of the aggregate-batch version.                             |
| `batchId`                 | string (1–128)  |   yes    | Deterministic hash of `pseudonymousDeveloperId + window.start + window.end + schemaVersion`. A stable identity for the batch; the importer does not key anything on it. See §5. |
| `generatedAt`             | date-time       |   yes    | UTC build time. Diagnostics only.                                                      |
| `toolVersion`             | string (semver) |   yes    | Desktop app version.                                                                   |
| `pseudonymousDeveloperId` | string (36)     |   yes    | `^dev_[0-9a-f]{32}$`. Same derivation as the aggregate batch.                           |
| `window`                  | object          |   yes    | Closed-open UTC range `[start, end)`; `end` > `start`; `additionalProperties:false`.   |
| `rows`                    | array           |   yes    | Pre-aggregated context-file rows (may be empty, a valid heartbeat).                    |

---

## 4. Row grain and measures

Grain = `(bucketStart, bucketDurationSeconds, repository, contextFile, category)` for one
`pseudonymousDeveloperId`. `rowKey = sha256hex([pseudonymousDeveloperId, bucketStartIso, 1800,
repository, contextFile, category].join('|'))`.

| Field                        | Type                | Additive? | Notes                                                                       |
| ---------------------------- | ------------------- | :-------: | --------------------------------------------------------------------------- |
| `rowKey`                     | string (1–128)      |    n/a    | Deterministic per-row identity key. See §5.                                 |
| `bucketStart`                | date-time           |    n/a    | 30-minute-aligned UTC bin start.                                            |
| `bucketDurationSeconds`      | integer const 1800  |    n/a    | Global invariant.                                                          |
| `repository`                 | string (sanitized)  |    n/a    | `https://{host}/{owner}/{repo}` or `unknown`.                               |
| `contextFile`                | string (repo-rel)   |    n/a    | Allowlisted repo-relative POSIX path. See §2.                              |
| `category`                   | enum                |    n/a    | `instruction \| skill \| agent \| hook \| prompt` (`unknown` dropped).      |
| `appliedCount`               | integer ≥ 0         |    yes    | Times applied (loaded into context).                                       |
| `skippedCount`               | integer ≥ 0         |    yes    | Times discovered but skipped.                                              |
| `skipReasonCounts`           | object (closed-set) |    yes    | OPTIONAL; `{ applyToNoMatch?, other? }`. Omitted when `skippedCount` = 0.   |
| `estTokensSum`               | integer ≥ 0         |    yes    | Σ estimated token weight over applied sessions.                            |
| `estTokensMax`               | integer ≥ 0         |  **max**  | Max single-session token weight (a consumer takes max on merge).           |
| `sessionsWithErrorCount`     | integer ≥ 0         |    yes    | Distinct applied sessions with ≥1 errored span. Co-occurrence only.        |
| `sessionsWithDeviationCount` | integer ≥ 0         |    yes    | Distinct applied sessions with a workflow deviation. Co-occurrence only.    |
| `distinctSessionCount`       | integer ≥ 0         |  **no**   | Distinct sessions in this row only; never sum across rows.                 |
| `lastActivityAtMs`           | integer ≥ 0         |  **max**  | OPTIONAL; latest session start (epoch ms) in the row.                       |

---

## 5. Idempotency

Identical input yields a byte-identical batch except `generatedAt`. Each team export rebuilds the
**complete** batch for its window (the last 90 days of completed 30-minute bins) and replaces the
member's previous shard file wholesale; the importer keeps one shard per member (the newest
`generatedAt`), so rows never accumulate across exports and nothing is upserted row by row. The
aggregate and context-insights batches use the same deterministic SHA-256 recipe
(`[fields].join('|')`, lowercase hex), so row identity is stable across exports and machines.
