# Context-Insights Payload Schema v1

Status: Implemented. Producer: `src/core/agent-observability-core/src/aggregate/contextInsightsAggregator.ts`. Consumer: `src/dashboard/AgentObservability.Dashboard/Services/Ingestion/ContextInsightsBatchValidator.cs`.
Schema file: [`schemas/context-insights-batch.schema.json`](../../schemas/context-insights-batch.schema.json)
`schemaVersion`: `"1.0"`

This document is the human-readable companion to the strict JSON Schema (draft 2020-12) that the
VS Code extension (TypeScript **producer**) POSTs to the dashboard's **context-insights** ingestion
API (C# **consumer**) at `POST /api/ingest/context-insights`. As with the aggregate-batch contract,
the JSON Schema is the source of truth and `"additionalProperties": false` at **every** object level
is the privacy-enforcement mechanism.

It is a **separate** contract from [`aggregate-batch.schema.json`](../../schemas/aggregate-batch.schema.json):
the v1 aggregate batch is unchanged by it, so its privacy tests and invariants still hold. The
two batches are produced in the same gated sync cycle, share the same `pseudonymousDeveloperId`
derivation and 30-minute `bucketStart` alignment, and are reviewed over the same sprint window.

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
errored or deviated is **not** a causal claim. The dashboard labels them accordingly.

---

## 2. The privacy boundary (what is new in this contract)

This is the **first** contract to convey repo-relative file **paths** to the cloud. It is tightly
scoped so the incremental disclosure is bounded and predictable:

- **Customization files only.** Source/doc files pulled into context (via `read_file`/attachments)
  are out of scope and **cannot** satisfy the `contextFile` pattern.
- **Repo-relative POSIX paths only.** The extension resolves each customization file against the
  developer's **open workspace** and emits a repo-relative path. Files that do not resolve inside
  the repo (user/global-scope customization files, e.g. in the VS Code user prompts folder) are
  **dropped**. This is how "repo-scoped only" is enforced.
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

Consent: this rides the **existing** single sync opt-in (`agentObservability.sync.enabled` + the
shared consent gate). Because it broadens what leaves the machine, the opt-in's disclosure copy and
[onboarding](../onboarding.md) call out that repo-relative customization-file paths are included.
See [`pseudonymization-strategy.md`](pseudonymization-strategy.md) and
[`../privacy-validation.md`](../privacy-validation.md).

---

## 3. Envelope

One batch covers one contiguous UTC `window` for one developer.

| Field                     | Type            | Required | Notes                                                                                  |
| ------------------------- | --------------- | :------: | -------------------------------------------------------------------------------------- |
| `schemaVersion`           | string const    |   yes    | Always `"1.0"`. Independent of the aggregate-batch version.                             |
| `batchId`                 | string (1–128)  |   yes    | Deterministic hash of `pseudonymousDeveloperId + window.start + window.end + schemaVersion`. Idempotency hint only; correctness is per-row `rowKey` upsert. |
| `generatedAt`             | date-time       |   yes    | UTC build time. Diagnostics only.                                                      |
| `toolVersion`             | string (semver) |   yes    | Extension version.                                                                     |
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
| `rowKey`                     | string (1–128)      |    n/a    | Per-row idempotency key (upsert, latest-wins).                              |
| `bucketStart`                | date-time           |    n/a    | 30-minute-aligned UTC bin start.                                            |
| `bucketDurationSeconds`      | integer const 1800  |    n/a    | Global invariant.                                                          |
| `repository`                 | string (sanitized)  |    n/a    | `https://{host}/{owner}/{repo}` or `unknown`.                               |
| `contextFile`                | string (repo-rel)   |    n/a    | Allowlisted repo-relative POSIX path. See §2.                              |
| `category`                   | enum                |    n/a    | `instruction \| skill \| agent \| hook \| prompt` (`unknown` dropped).      |
| `appliedCount`               | integer ≥ 0         |    yes    | Times applied (loaded into context).                                       |
| `skippedCount`               | integer ≥ 0         |    yes    | Times discovered but skipped.                                              |
| `skipReasonCounts`           | object (closed-set) |    yes    | OPTIONAL; `{ applyToNoMatch?, other? }`. Omitted when `skippedCount` = 0.   |
| `estTokensSum`               | integer ≥ 0         |    yes    | Σ estimated token weight over applied sessions.                            |
| `estTokensMax`               | integer ≥ 0         |  **max**  | Max single-session token weight (server takes max on merge).               |
| `sessionsWithErrorCount`     | integer ≥ 0         |    yes    | Distinct applied sessions with ≥1 errored span. Co-occurrence only.        |
| `sessionsWithDeviationCount` | integer ≥ 0         |    yes    | Distinct applied sessions with a workflow deviation. Co-occurrence only.    |
| `distinctSessionCount`       | integer ≥ 0         |  **no**   | Distinct sessions in this row only; recombine server-side.                 |
| `lastActivityAtMs`           | integer ≥ 0         |  **max**  | OPTIONAL; latest session start (epoch ms) in the row.                       |

---

## 5. Idempotency

Identical input yields a byte-identical batch except `generatedAt`. Re-sending an overlapping window
is safe: the server upserts by `rowKey` (latest-wins). The aggregate and context-insights batches use
the same deterministic SHA-256 recipe (`[fields].join('|')`, lowercase hex) so producer and consumer
agree on row identity.
