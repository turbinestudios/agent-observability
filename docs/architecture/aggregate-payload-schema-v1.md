# Aggregate Payload Schema v1

Status: Implemented. Producer: `src/core/agent-observability-core/src/aggregate/aggregator.ts`,
run by the desktop app's team export. Consumer: the desktop's team-shard importer, through
`src/core/agent-observability-core/src/team/teamShardValidator.ts` and
`src/core/agent-observability-core/src/aggregate/batchValidators.ts`.
Schema file: [`schemas/aggregate-batch.schema.json`](../../schemas/aggregate-batch.schema.json)
`schemaVersion`: `"1.0"`

This document is the human-readable companion to the strict JSON Schema (draft 2020-12) for the
**aggregate batch**. The batch travels only **embedded unchanged** in the desktop app's **team
shard** ([`schemas/team-shard.schema.json`](../../schemas/team-shard.schema.json)): one JSON file
per member, written to a folder the user chose. Core's aggregator (TypeScript **producer**) builds
it during the team export; the team-shard importer in every member's app (the **consumer**)
validates each shard it reads before merging it. It is a **single shared contract**: the JSON
Schema is the source of truth, the TypeScript interface below is kept identical in shape to it,
and the TypeScript validators in `batchValidators.ts` are kept in step with it.

The contract exists to enforce the privacy-first split: individual
raw usage data (prompts, tool arguments, file paths, identities) stays local; only **pre-aggregated,
non-sensitive measures** leave the machine. The mechanism that guarantees this is
`"additionalProperties": false` at **every** object level: the producer validates its own shard
against the same rules before writing it, and the importer skips (with a visible notice) any shard
whose batch carries a field not explicitly listed here, so a coding mistake in the producer cannot
silently leak a raw column.

---

## 1. Why aggregate, and what a consumer can derive

The buckets are pre-summed so that a consumer never needs raw rows. From them a consumer can
derive, **without** any raw content:

| Figure                                   | Derived from                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Requests / interactions                  | Σ `interactionCount`                                                    |
| Token volume (by day, repository, model) | Σ `inputTokens`, `outputTokens`, `cachedTokens`, `reasoningTokens`      |
| Average latency                          | Σ `durationMsSum` / Σ `interactionCount`, after merge                   |
| Approximate p95 latency                  | merged `latencyHistogram` (§8)                                          |
| Active members, repositories, models     | distinct dimension values at read time (§9)                             |
| Last seen                                | max `lastActivityAtMs`                                                  |

The Team view today reads token sums from the buckets, keyed by the UTC day of `bucketStart`
(`src/core/agent-observability-core/src/team/teamMetrics.ts`); sessions, verdicts and cost come
from the shard's own `outcomes` block, not from this batch. The remaining measures are part of
the contract, and any consumer that merges them must follow §8 and §9.

Identity is replaced by `pseudonymousDeveloperId`; no email or user id is ever shipped.

---

## 2. Envelope

The top-level object is the **batch envelope**. One batch covers one contiguous time `window` for
one developer.

| Field                     | Type             | Required | Notes                                                                                                                                                                                       |
| ------------------------- | ---------------- | :------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`           | string const     |    yes   | Always `"1.0"`. The importer rejects anything else.                                                                                                                                         |
| `batchId`                 | string (1–128)   |    yes   | **Deterministic batch identity.** Hash of `pseudonymousDeveloperId + window.start + window.end + schemaVersion`. Re-exporting the same window yields the same `batchId`. The importer does not key anything on it. See §5. |
| `generatedAt`             | date-time        |    yes   | UTC time the producer built the batch. Diagnostics only; not part of any idempotency key.                                                                                                  |
| `toolVersion`             | string (semver)  |    yes   | Desktop app version, e.g. `"1.4.2"`. For schema-drift triage.                                                                                                                                 |
| `pseudonymousDeveloperId` | string (36)      |    yes   | Opaque salted hash: literal `dev_` + 32 lowercase hex chars (`^dev_[0-9a-f]{32}$`, exactly 36 chars), **NOT** an email, OS username, or machine name. See §6. Used by consumers as a distinct-count dimension for "active members".                                       |
| `window`                  | object           |    yes   | Closed-open UTC range `[start, end)` covered by the buckets. `end` MUST be `> start`.                                                                                                       |
| `buckets`                 | array            |    yes   | Pre-aggregated rows (may be empty; an empty array is a valid "no activity" heartbeat).                                                                                                     |

`window.start` / `window.end` are both required `date-time` values and the only properties of
`window` (`additionalProperties: false`).

---

## 3. Bucket grain and dimensions

Each element of `buckets` is **one aggregate row** at the grain:

```
(bucketStart, bucketDurationSeconds, repository, model, agentMode, operation, toolName?)
```

scoped to the envelope's single `pseudonymousDeveloperId`.

| Field                   | Type            | Required | Notes                                                                                                                                                                       |
| ----------------------- | --------------- | :------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rowKey`                | string (1–128)  |    yes   | **Row identity key.** Hash of the full grain tuple + `pseudonymousDeveloperId`. Unique within a batch. See §5.                                                         |
| `bucketStart`           | date-time       |    yes   | Aligned UTC bin start. **Always 30-minute-aligned in v1** (minutes ∈ {00,30}, seconds=0, ms=0).                                                                            |
| `bucketDurationSeconds` | integer const   |    yes   | Bin width in seconds. **GLOBAL INVARIANT: const `1800` (30 minutes)**. Bin width is globally fixed, not per-batch; changing it is a `schemaVersion` bump, never a re-send.                                                                 |
| `repository`            | string (1–512)  |    yes   | **SANITIZED** git remote resolved per session (see §4), normalized to `https://{host}/{owner}/{repo}`, else `"unknown"`. Pattern `^(unknown\|https?://[A-Za-z0-9.\-]+(:[0-9]+)?/[^\s@?#]+)$` structurally forbids `@`, `?`, `#`, and whitespace so credential-bearing remotes cannot pass. **May be hashed in a future version**, so consumers must not assume it stays a plain URL.   |
| `repositoryBranch`      | string (≤256)   |    no    | **Never emitted by the producer.** Source `copilot_chat.repo.head_branch_name`. Privacy tradeoff in §7. Never required.                                                               |
| `model`                 | string (1–128)  |    yes   | COALESCE of `gen_ai.response.model` / `gen_ai.request.model`, else `"unknown"`.                                                                                            |
| `agentMode`             | string (1–64)   |    yes   | `copilot_chat.mode_name`, default `"default"`. The producer MUST map any mode outside the known set `{default, ask, edit, agent}` to the literal `"custom"` (custom mode names can embed project/customer identifiers). See §5.1.                                                                                                                            |
| `operation`             | enum            |    yes   | One of `chat`, `execute_tool`, `execute_hook`, `invoke_agent` (OTEL `operation_name`).                                                                                     |
| `toolName`              | string (≤128)   |    no    | Present only when `operation = "execute_tool"`. Source `gen_ai.tool.name` (e.g. `read_file`). Built-in Copilot tool names pass through verbatim; any third-party/MCP tool name maps to `"custom"`. See §5.1. Tool **arguments/results are never included.**                              |

### Measures (all per row)

| Field                  | Type        | Required | Additive? | Notes                                                                                                       |
| ---------------------- | ----------- | :------: | :-------: | ----------------------------------------------------------------------------------------------------------- |
| `interactionCount`     | integer ≥ 0 |    yes   |    yes    | Spans in this row → `Requests` / `TotalRequests`.                                                            |
| `successCount`         | integer ≥ 0 |    yes   |    yes    | Count of spans with `status_code` ∈ {0 unset, 1 ok}. See §7.1.                                              |
| `errorCount`           | integer ≥ 0 |    yes   |    yes    | Count of spans with `status_code = 2` (error). See §7.1.                                                     |
| `inputTokens`          | integer ≥ 0 |    yes   |    yes    | Σ `input_tokens` over chat spans.                                                                            |
| `outputTokens`         | integer ≥ 0 |    yes   |    yes    | Σ `output_tokens` over chat spans.                                                                           |
| `cachedTokens`         | integer ≥ 0 |    yes   |    yes    | Σ `cached_tokens`.                                                                                           |
| `reasoningTokens`      | integer ≥ 0 |    no    |    yes    | Σ `reasoning_tokens`. Omitted when provider does not report it.                                              |
| `durationMsSum`        | number ≥ 0  |    yes   |    yes    | Σ (`end_time_ms − start_time_ms`). Average latency = `durationMsSum / interactionCount`, computed **after** merge. A pre-computed average is intentionally not shipped (averages are not additive). |
| `latencyHistogram`     | object      |    yes   |    yes*   | Fixed-bound histogram; counts merge bound-for-bound. See §8.                                                 |
| `distinctSessionCount` | integer ≥ 0 |    yes   |  **NO**   | Distinct `COALESCE(conversation_id, chat_session_id)` **within this row only**. NOT additive (see §9).       |
| `lastActivityAtMs`     | integer ≥ 0 |    no    |  max**    | Unix epoch **milliseconds** of the latest span `start_time_ms` in this row (max over the row). Lets a consumer recover a member's last-seen time at true event resolution (max across the member's rows) instead of degrading it to the 30-minute `bucketStart`. Non-sensitive (a timestamp). |

\* `latencyHistogram.counts` is additive element-wise; `boundsMs` is a fixed constant shared by all rows.
\*\* `lastActivityAtMs` is combined across rows by taking the **max**, not by summing.

---

## 4. Repository resolution

`copilot_chat.repo.remote_url` is **sparse**: present on only ~17 of 429 spans in the captured DB.
The producer therefore resolves the repository per session before bucketing:

1. For each session `COALESCE(conversation_id, chat_session_id)`, take any non-empty
   `copilot_chat.repo.remote_url`.
2. **SANITIZE the resolved URL (MANDATORY: applied before it can ever be bucketed or shipped).**
3. Apply the sanitized value to every span in the session.
4. Spans whose session never observed a remote URL are bucketed under `repository = "unknown"`.

This keeps repository attribution stable across the many spans (tool calls, hooks) that never carry
the URL themselves.

### 4.1 Mandatory sanitization (privacy-critical)

A raw git remote can embed credentials (`https://user:token@host/...`,
`https://x-access-token:ghp_...@host/...`), query strings, fragments, or a `.git` suffix. Such a
value would leak a PAT/credential off the machine. The producer MUST normalize every resolved remote
to canonical `https://{host}/{owner}/{repo}` form **before** it touches a bucket key or payload:

- **Strip userinfo:** drop any `user:token@` / `x-access-token@` segment entirely.
- **Strip query and fragment:** drop everything from `?` or `#` onward.
- **Drop a trailing `.git`** suffix.
- **Convert SSH remotes:** `git@host:owner/repo` (and `ssh://git@host/owner/repo`) become
  `https://host/owner/repo`.
- **Fallback:** anything that cannot be normalized to the canonical host/path form becomes the
  literal `"unknown"`.

The schema enforces this structurally: the `repository` pattern
`^(unknown|https?://[A-Za-z0-9.\-]+(:[0-9]+)?/[^\s@?#]+)$` forbids `@`, `?`, `#`, and whitespace, so
a credential-bearing remote **cannot** validate and the whole shard is rejected if sanitization is
skipped. Sanitization is therefore both a producer obligation and a hard schema guarantee.

---

## 5. Identity keys and replacement semantics

Both keys are deterministic, so the same input always yields the same keys on every machine.

- **`rowKey`**: `hash(pseudonymousDeveloperId | bucketStart | bucketDurationSeconds | repository | model | agentMode | operation | toolName)`.
  It names one cell of the grain and is unique within a batch.
- **`batchId`**: `hash(pseudonymousDeveloperId | window.start | window.end | schemaVersion)`.

Hash recipe (as implemented in `aggregator.ts`): lowercase hex SHA-256 over the UTF-8 of the fields
joined by `|`, in the order shown above, with an absent `toolName` rendered as the empty string,
`bucketStart` and the window bounds as ISO 8601 UTC strings, and `schemaVersion` as `1.0`. The
contract itself only requires the keys to be stable and collision-resistant.

> Replacement, not accumulation: each team export rebuilds the **complete** batch for its window
> (the last 90 days of completed 30-minute bins) and overwrites the member's previous shard file.
> The importer keeps one shard per member, the newest `generatedAt`
> (`src/core/agent-observability-core/src/team/teamMerge.ts`), so overlapping exports never
> double-count. The producer must therefore emit the *complete* aggregate for a (window, grain)
> cell in each batch, not a delta.

### 5.1 Dimension value mapping (`agentMode`, `toolName`)

Two dimension values are user-/vendor-defined and could embed project, customer, or ticket
identifiers. The producer MUST collapse the open-ended cases to a fixed literal **before** computing
`rowKey` or emitting the bucket, so no free text leaves the machine and the grain stays low-cardinality:

- **`agentMode`:** values in the known set `{default, ask, edit, agent}` pass through verbatim
  (`copilot_chat.mode_name`, defaulting to `"default"` when absent). **Any mode outside that set maps
  to the literal `"custom"`.** Custom chat-mode names are user-defined and may carry identifiers.
- **`toolName`:** built-in Copilot tool names (e.g. `read_file`, `run_in_terminal`, `list_dir`,
  `grep_search`, `create_file`) pass through verbatim. **Any third-party / MCP tool name (one outside
  the built-in allowlist) maps to the literal `"custom"`.** Third-party tool names are
  vendor-defined and may embed identifiers.

Only the mapped value appears in the payload and contributes to `rowKey`.

---

## 6. Pseudonymous developer id

There is **no developer email or identity in the local Copilot DB.** The desktop mints a
pseudonymous id locally:

- Opaque, stable per install, salted hash (see
  [`pseudonymization-strategy.md`](pseudonymization-strategy.md)). Specifically: literal `dev_`
  prefix + 32 lowercase hex chars (first 16 bytes of `HMAC-SHA256(salt, normalizedIdentity)`),
  e.g. `dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3`.
- Constrained by the schema to `^dev_[0-9a-f]{32}$`, **exactly 36 characters**, which structurally
  **excludes** an email address or any free-text PII (no `@`, no uppercase, no characters outside
  `[0-9a-f]` after the `dev_` prefix; an email simply cannot satisfy the pattern).
- Used by consumers purely as a **distinct-count dimension** for "active members" and to scope a
  member's rows. It is never displayed as a name.

---

## 7. Forbidden fields (rejected by `additionalProperties: false`)

The following MUST NEVER appear anywhere in the payload. Because every object sets
`additionalProperties: false`, the importer will **skip the whole shard** if any of them (or any
other unlisted field) is present. This is the raw-field-rejection mechanism and a privacy regression test.

Raw content (12 sensitive `span_attributes` keys, matching the snapshot's `sensitive: true` set):

- `copilot_chat.user_request`
- `gen_ai.input.messages`, `gen_ai.output.messages`
- `gen_ai.system_instructions`
- `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`
- `gen_ai.tool.definitions`, `gen_ai.tool.description`
- `copilot_chat.reasoning_content`
- `copilot_chat.hook_input`, `copilot_chat.hook_output`, `copilot_chat.hook_command`

Raw / sensitive request internals (also `sensitive: true` in the snapshot):

- `copilot_chat.request.options`: flagged sensitive in the captured DB (may embed request
  internals); never shipped.

Identifying / environment data:

- file paths, commit hashes (`copilot_chat.repo.head_commit_hash`)
- machine name, OS username, developer email / `user.email` / `UserId`
- raw session ids, conversation ids, trace/span ids (only the *count* of distinct sessions ships)

Borderline, kept local, NOT shipped:

- `repositoryBranch` (`copilot_chat.repo.head_branch_name`) is **the only borderline field with a
  defined slot**, and the producer **never emits it** (§3). Branch names can encode feature, customer,
  or ticket identifiers; the slot exists in the schema only.
- `status_message` (`spans.status_message`) may echo an error string; kept local, never shipped.
- `error.type` is an error classification, kept local for diagnostics, not part of any v1 bucket
  field. (Error volume leaves the machine only as the aggregate `errorCount`, see §7.1.)

### 7.1 Success / error semantics

`successCount` and `errorCount` are derived from the OTEL `spans.status_code` (`0`=unset, `1`=ok,
`2`=error):

- **`successCount`** = count of spans with `status_code` ∈ **{0 unset, 1 ok}**.
- **`errorCount`** = count of spans with `status_code` = **2 (error)**.
- These partition the row: `successCount + errorCount = interactionCount`.
- **Error rate** is computed by the consumer as `errorCount / interactionCount`.

**Treatment of `unset` (0):** `status_code = 0` (unset) is deliberately counted as a **non-error**
(folded into `successCount`), because Copilot leaves many non-`chat` spans (tools, hooks) at the
unset default and treating those as failures would inflate the error rate. This
unset-as-success convention is an explicit definition of this contract. (In the captured snapshot the split is `0`→147, `1`→148, `2`→134.)

---

## 8. Latency histogram (mergeable approximate percentiles)

Averages can be derived from `durationMsSum / interactionCount`, but **percentiles cannot be summed**.
To let a consumer approximate p95 over an arbitrary time range while still merging buckets, each row
carries a fixed-bound histogram:

```jsonc
"latencyHistogram": {
  "boundsMs": [100, 250, 500, 1000, 2000, 5000, 10000, 30000], // FIXED, shared by every row
  "counts":   [/* length 9 */]                                  // boundsMs.length + 1
}
```

- `boundsMs` is a constant (enforced via `const` in the schema) so histograms from different rows,
  developers, and batches are **element-wise mergeable**.
- `counts` has length `boundsMs.length + 1 = 9`. `counts[i]` (for `i < 8`) = spans with duration in
  `(boundsMs[i-1], boundsMs[i]]`; `counts[8]` = the **`+Inf` overflow** bucket (duration > 30000 ms).
- p95 over a range: sum the `counts` arrays element-wise across all matching rows, then
  walk the cumulative distribution to the bucket containing the 95th percentile and interpolate
  within its `[lowerBound, upperBound]` (the overflow bucket reports `≥ 30000 ms`).

This approximates p95 latency without shipping raw per-span durations.

---

## 9. Distinct counts MUST be computed at read time (critical)

Active members, active repositories and unique models are **distinct counts**. Distinct counts
are **not additive across time bins**, so they cannot be pre-summed in the bucket measures:

- If developer *D* is active in two adjacent 30-minute bins, those two rows each report
  `distinctDevelopers = 1`. Summing gives **2**, but the true distinct count for the combined range is
  **1**.

Therefore:

- The payload deliberately ships **dimension values** (`pseudonymousDeveloperId` on the envelope,
  `repository`, `model` on each bucket), **not** pre-computed dcounts of them.
- `distinctSessionCount` is included only as **per-row context** and is explicitly flagged
  non-additive; a consumer must not sum it for a range total.
- A consumer computes distinct counts **at read time** by counting distinct dimension values
  across the rows in the requested range:
  - Active members = `COUNT(DISTINCT pseudonymousDeveloperId)` over rows in range.
  - Active repositories = `COUNT(DISTINCT repository)`, excluding `"unknown"`.
  - `UniqueModels` per repo/developer = `COUNT(DISTINCT model)` over that subset.
  - True distinct sessions over a range = `COUNT(DISTINCT session)`, which is why the *count* alone
    is insufficient and `distinctSessionCount` stays per-row context only.

Additive measures (`interactionCount`, token sums, `durationMsSum`, histogram `counts`) **are**
summed across rows; distinct counts are **not**. This split is the core correctness rule of the
aggregate contract. (The Team view goes further and takes session counts only from the shard's
`outcomes` block, because a session spanning three bins appears in three rows.)

---

## 10. TypeScript interface (producer)

Kept identical in shape to the JSON Schema
(`src/core/agent-observability-core/src/aggregate/models.ts`). The producer emits exactly this
object.

```ts
/** schemaVersion is always "1.0" in v1. */
export type SchemaVersion = "1.0";

export type Operation = "chat" | "execute_tool" | "execute_hook" | "invoke_agent";

/** FIXED canonical bounds, shared by every row so histograms are mergeable. */
export const LATENCY_BOUNDS_MS = [100, 250, 500, 1000, 2000, 5000, 10000, 30000] as const;

export interface LatencyHistogram {
  /** Must equal LATENCY_BOUNDS_MS. */
  boundsMs: number[];
  /** Length = boundsMs.length + 1 (= 9); last element is the +Inf overflow bucket. */
  counts: number[];
}

export interface AggregateBucket {
  rowKey: string;
  bucketStart: string;            // ISO 8601 UTC, 30-min-aligned (minutes in {00,30}, sec=0)
  bucketDurationSeconds: 1800;    // const 1800 (30 minutes), global invariant in v1
  repository: string;             // SANITIZED https://{host}/{owner}/{repo} or "unknown"
  repositoryBranch?: string;      // never emitted by the producer
  model: string;                  // or "unknown"
  agentMode: string;              // default "default"; non-{default,ask,edit,agent} mapped to "custom"
  operation: Operation;
  toolName?: string;              // only when operation === "execute_tool"; non-builtin mapped to "custom"

  interactionCount: number;       // integer >= 0
  successCount: number;           // status_code in {0 unset, 1 ok}
  errorCount: number;             // status_code === 2
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  reasoningTokens?: number;       // optional
  durationMsSum: number;
  latencyHistogram: LatencyHistogram;
  distinctSessionCount: number;   // per-row context only; NOT additive
  lastActivityAtMs?: number;      // optional; Unix epoch ms of latest span start (max over row)
}

export interface AggregateWindow {
  start: string; // ISO 8601 UTC, inclusive
  end: string;   // ISO 8601 UTC, exclusive, > start
}

export interface AggregateBatch {
  schemaVersion: SchemaVersion;   // "1.0"
  batchId: string;                // deterministic idempotency key
  generatedAt: string;            // ISO 8601 UTC
  toolVersion: string;            // semver
  pseudonymousDeveloperId: string;// "dev_" + 32 lowercase hex (^dev_[0-9a-f]{32}$), NOT email
  window: AggregateWindow;
  buckets: AggregateBucket[];
}
```

---

## 11. Worked example

```json
{
  "schemaVersion": "1.0",
  "batchId": "b3f1c0a9e4d24c6f8a1b2c3d4e5f6071829304a5b6c7d8e9f0a1b2c3d4e5f607",
  "generatedAt": "2026-06-02T09:15:00Z",
  "toolVersion": "1.4.2",
  "pseudonymousDeveloperId": "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3",
  "window": { "start": "2026-06-02T08:00:00Z", "end": "2026-06-02T08:30:00Z" },
  "buckets": [
    {
      "rowKey": "a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718a1b2c3d4e5f60718",
      "bucketStart": "2026-06-02T08:00:00Z",
      "bucketDurationSeconds": 1800,
      "repository": "https://github.com/turbinestudios/agent-observability",
      "model": "gpt-4.1",
      "agentMode": "agent",
      "operation": "chat",
      "interactionCount": 12,
      "successCount": 11,
      "errorCount": 1,
      "inputTokens": 84210,
      "outputTokens": 9043,
      "cachedTokens": 61200,
      "reasoningTokens": 1500,
      "durationMsSum": 41230.0,
      "latencyHistogram": {
        "boundsMs": [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
        "counts": [0, 1, 2, 3, 4, 1, 1, 0, 0]
      },
      "distinctSessionCount": 3,
      "lastActivityAtMs": 1780387740000
    },
    {
      "rowKey": "f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687f0e1d2c3b4a59687",
      "bucketStart": "2026-06-02T08:00:00Z",
      "bucketDurationSeconds": 1800,
      "repository": "https://github.com/turbinestudios/agent-observability",
      "model": "unknown",
      "agentMode": "agent",
      "operation": "execute_tool",
      "toolName": "read_file",
      "interactionCount": 27,
      "successCount": 27,
      "errorCount": 0,
      "inputTokens": 0,
      "outputTokens": 0,
      "cachedTokens": 0,
      "durationMsSum": 1830.0,
      "latencyHistogram": {
        "boundsMs": [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
        "counts": [20, 5, 2, 0, 0, 0, 0, 0, 0]
      },
      "distinctSessionCount": 2,
      "lastActivityAtMs": 1780387710000
    }
  ]
}
```

---

## 12. Tradeoffs chosen

- **30-minute bins (`bucketDurationSeconds` const 1800).** The width is a **global invariant**,
  not a per-batch field: because both width and alignment are fixed, `rowKey`s for the same wall-clock
  window are identical across exports, and members' rows line up bin for bin. Changing the bin width is a breaking change requiring a
  `schemaVersion` bump, never a re-send at a different width.
- **Whole-shard replacement, full aggregate per cell (not deltas).** Each export overwrites the
  member's previous shard and the importer keeps only the newest per member, which tolerates
  re-exports and overlapping windows. Cost: the producer must emit the complete value for a cell
  each time.
- **Fixed histogram bounds over t-digest/exact percentiles.** Slightly approximate p95, but trivially
  mergeable across rows/members and tiny in the file (9 integers).
- **Distinct dimensions shipped, distinct counts computed at read time.** The only correct option
  (distinct counts are not additive). Cost: the consumer must scan dimension values, not just
  summed metrics.
- **`repository` as a plain URL in v1, hashing deferred.** Repo URL is team-relevant and explicitly
  allowed; documented as possibly hashed later so consumers do not hard-depend on URL structure.
- **`repositoryBranch` slot defined but never emitted.** Kept in the contract without a
  schema change, while defaulting to the privacy-safe choice.
- **`additionalProperties: false` everywhere.** Turns the schema validator into the privacy
  enforcement layer: any raw/forbidden field causes outright rejection rather than a silent merge.
