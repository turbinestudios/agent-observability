# Aggregate Payload Schema v1

Status: Accepted (Phase 0 contract)
Schema file: [`schemas/aggregate-batch.schema.json`](../../schemas/aggregate-batch.schema.json)
`schemaVersion`: `"1.0"`

This document is the human-readable companion to the strict JSON Schema (draft 2020-12) that the
VS Code extension (TypeScript **producer**) POSTs to the dashboard ingestion API (C# **consumer**).
It is a **single shared contract**: the JSON Schema is the source of truth, and the TypeScript
interface and C# record below are kept identical in shape to it.

The contract exists to enforce the privacy-first split described in the refactor plan: individual
raw usage data (prompts, tool arguments, file paths, identities) stays local; only **pre-aggregated,
non-sensitive measures** travel to the cloud. The mechanism that guarantees this is
`"additionalProperties": false` at **every** object level — the API rejects any payload that
carries a field not explicitly listed here, so a coding mistake in the extension cannot silently
leak a raw column.

---

## 1. Why aggregate, and what the cloud must still produce

The legacy cloud path (`LogAnalyticsService`) queried raw `AppDependencies` rows and computed the
web pages on the fly. The aggregate store must reproduce the **same four pages** from pre-summed
buckets:

| Web page (model)                                  | What it needs from the aggregate store                                                                   |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Overview (`DashboardMetrics`)                     | `TotalRequests`, `AverageLatencyMs`, `P95LatencyMs`, `ActiveRepositories`, `ActiveDevelopers`, request-volume time series, model breakdown |
| Repository activity (`RepositoryActivitySummary`) | per-repo `Requests`, `ActiveDevelopers`, `AverageLatencyMs`, `UniqueModels`                              |
| Developer activity (`DeveloperActivitySummary`)   | per-(developer, repo) `Requests`, `AverageLatencyMs`, `UniqueModels`, `LastSeen`                          |
| Model usage (`NamedValue`)                        | per-model `Requests`, `InputTokens`, `OutputTokens`                                                       |

Every one of those outputs is derivable from the bucket measures defined below **without** any raw
content. Identity is replaced by `pseudonymousDeveloperId`; the real `user.email` / `UserId`
COALESCE used by `LogAnalyticsService` has no equivalent in the local DB and is never shipped.

---

## 2. Envelope

The top-level object is the **batch envelope**. One batch covers one contiguous time `window` for
one developer.

| Field                     | Type             | Required | Notes                                                                                                                                                                                       |
| ------------------------- | ---------------- | :------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`           | string const     |    yes   | Always `"1.0"`. The API rejects anything else.                                                                                                                                              |
| `batchId`                 | string (1–128)   |    yes   | **Batch idempotency hint (optimization only).** Deterministic hash of `pseudonymousDeveloperId + window.start + window.end + schemaVersion`. Re-uploading the same window yields the same `batchId`. The API MAY skip re-processing a byte-identical retry, but correctness comes from per-row `rowKey` upserts — a repeated `batchId` carrying corrected/fuller buckets MUST still re-apply row upserts. See §5. |
| `generatedAt`             | date-time        |    yes   | UTC time the extension built the batch. Diagnostics only; not part of any idempotency key.                                                                                                  |
| `toolVersion`             | string (semver)  |    yes   | Extension version, e.g. `"1.4.2"`. For schema-drift triage.                                                                                                                                 |
| `pseudonymousDeveloperId` | string (36)      |    yes   | Opaque salted hash: literal `dev_` + 32 lowercase hex chars (`^dev_[0-9a-f]{32}$`, exactly 36 chars) — **NOT** an email, OS username, or machine name. See §6. Used as a server-side distinct-count dimension for "active developers".                                       |
| `window`                  | object           |    yes   | Closed-open UTC range `[start, end)` covered by the buckets. `end` MUST be `> start`.                                                                                                       |
| `buckets`                 | array            |    yes   | Pre-aggregated rows (may be empty — an empty array is a valid "no activity" heartbeat).                                                                                                     |

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
| `rowKey`                | string (1–128)  |    yes   | **Row idempotency key.** Hash of the full grain tuple + `pseudonymousDeveloperId`. Server upserts by `rowKey` (latest-wins). See §5.                                       |
| `bucketStart`           | date-time       |    yes   | Aligned UTC bin start. **Always 30-minute-aligned in v1** (minutes ∈ {00,30}, seconds=0, ms=0).                                                                            |
| `bucketDurationSeconds` | integer const   |    yes   | Bin width in seconds. **GLOBAL INVARIANT: const `1800` (30 minutes)** — matches the legacy `bin(TimeGenerated,30m)`. Bin width is globally fixed, not per-batch; changing it is a `schemaVersion` bump, never a re-send.                                                                 |
| `repository`            | string (1–512)  |    yes   | **SANITIZED** git remote resolved per session (see §4) — normalized to `https://{host}/{owner}/{repo}`, else `"unknown"`. Pattern `^(unknown\|https?://[A-Za-z0-9.\-]+(:[0-9]+)?/[^\s@?#]+)$` structurally forbids `@`, `?`, `#`, and whitespace so credential-bearing remotes cannot pass. **May be hashed in a future version** — consumers must not assume it stays a plain URL.   |
| `repositoryBranch`      | string (≤256)   |    no    | **OMITTED by default.** Source `copilot_chat.repo.head_branch_name`. Privacy tradeoff in §7. Never required.                                                               |
| `model`                 | string (1–128)  |    yes   | COALESCE of `gen_ai.response.model` / `gen_ai.request.model`, else `"unknown"`.                                                                                            |
| `agentMode`             | string (1–64)   |    yes   | `copilot_chat.mode_name`, default `"default"`. The extension MUST map any mode outside the known set `{default, ask, edit, agent}` to the literal `"custom"` (custom mode names can embed project/customer identifiers). See §5.1.                                                                                                                            |
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
| `distinctSessionCount` | integer ≥ 0 |    yes   |  **NO**   | Distinct `COALESCE(conversation_id, chat_session_id)` **within this row only**. NOT additive — see §9.       |
| `lastActivityAtMs`     | integer ≥ 0 |    no    |  max**    | Unix epoch **milliseconds** of the latest span `start_time_ms` in this row (max over the row). Lets the server recover `DeveloperActivitySummary.LastSeen` at true event resolution (max across a developer's rows) instead of degrading it to the 30-minute `bucketStart`. Non-sensitive (a timestamp). |

\* `latencyHistogram.counts` is additive element-wise; `boundsMs` is a fixed constant shared by all rows.
\*\* `lastActivityAtMs` is combined across rows by taking the **max**, not by summing.

---

## 4. Repository resolution (mirrors `LogAnalyticsService`)

`copilot_chat.repo.remote_url` is **sparse** — present on only ~17 of 429 spans in the captured DB.
The extension resolves it per session before bucketing, exactly like the cloud's `RepoBySession`
join:

1. For each session `COALESCE(conversation_id, chat_session_id)`, take any non-empty
   `copilot_chat.repo.remote_url`.
2. **SANITIZE the resolved URL (MANDATORY — applied before it can ever be bucketed or shipped).**
3. Apply the sanitized value to every span in the session.
4. Spans whose session never observed a remote URL are bucketed under `repository = "unknown"`.

This keeps repository attribution stable across the many spans (tool calls, hooks) that never carry
the URL themselves.

### 4.1 Mandatory sanitization (privacy-critical)

A raw git remote can embed credentials (`https://user:token@host/...`,
`https://x-access-token:ghp_...@host/...`), query strings, fragments, or a `.git` suffix. Such a
value would leak a PAT/credential to the cloud. The extension MUST normalize every resolved remote
to canonical `https://{host}/{owner}/{repo}` form **before** it touches a bucket key or payload:

- **Strip userinfo** — drop any `user:token@` / `x-access-token@` segment entirely.
- **Strip query and fragment** — drop everything from `?` or `#` onward.
- **Drop a trailing `.git`** suffix.
- **Convert SSH remotes** — `git@host:owner/repo` (and `ssh://git@host/owner/repo`) become
  `https://host/owner/repo`.
- **Fallback** — anything that cannot be normalized to the canonical host/path form becomes the
  literal `"unknown"`.

The schema enforces this structurally: the `repository` pattern
`^(unknown|https?://[A-Za-z0-9.\-]+(:[0-9]+)?/[^\s@?#]+)$` forbids `@`, `?`, `#`, and whitespace, so
a credential-bearing remote **cannot** validate and the whole batch is rejected if sanitization is
skipped. Sanitization is therefore both a producer obligation and a hard schema guarantee.

---

## 5. Idempotency keys

Two layers, both deterministic so retries and overlapping windows never double-count. **Per-row
upsert on `rowKey` (latest-wins) is the authoritative correctness mechanism; `batchId` is only an
optimization layered on top.**

- **`rowKey`** (authoritative) — `hash(bucketStart | bucketDurationSeconds | repository | model | agentMode | operation | toolName | pseudonymousDeveloperId)`.
  The API **upserts** aggregate rows keyed by `rowKey` (latest-wins). If two windows overlap, or the
  extension re-aggregates the same bin, the row converges to a single stored value instead of summing
  twice.
- **`batchId`** (optimization only) — `hash(pseudonymousDeveloperId | window.start | window.end | schemaVersion)`.
  It is at most a fast-path for **byte-identical retries**: the API MAY skip re-processing a payload
  whose `batchId` it has already fully applied. It **MUST NOT** be used to short-circuit a batch that
  differs in content. A repeated `batchId` carrying corrected or fuller buckets (e.g. late-arriving
  spans re-aggregated into the same window) **MUST still re-apply every row upsert** — the API must
  never silently drop a batch solely because the `batchId` was seen before. Correctness is owed to
  `rowKey`, not to `batchId` dedup.

Recommended hash: lowercase hex SHA-256 over the UTF-8 of the fields joined by `` (unit
separator), with `null`/absent optional fields rendered as the empty string. The exact recipe lives
with the extension's aggregate engine; the contract only requires the keys to be stable and
collision-resistant.

> Upsert semantics matter: because `rowKey` is an upsert key, the server stores the **latest** value
> for a row, not a sum of submissions. The extension must therefore emit the *complete* aggregate for
> a (window, grain) cell in each batch, not a delta.

### 5.1 Dimension value mapping (`agentMode`, `toolName`)

Two dimension values are user-/vendor-defined and could embed project, customer, or ticket
identifiers. The extension MUST collapse the open-ended cases to a fixed literal **before** computing
`rowKey` or emitting the bucket, so no free text reaches the cloud and the grain stays low-cardinality:

- **`agentMode`** — values in the known set `{default, ask, edit, agent}` pass through verbatim
  (`copilot_chat.mode_name`, defaulting to `"default"` when absent). **Any mode outside that set maps
  to the literal `"custom"`.** Custom chat-mode names are user-defined and may carry identifiers.
- **`toolName`** — built-in Copilot tool names (e.g. `read_file`, `run_in_terminal`, `list_dir`,
  `grep_search`, `create_file`) pass through verbatim. **Any third-party / MCP tool name — i.e. one
  outside the built-in allowlist — maps to the literal `"custom"`.** Third-party tool names are
  vendor-defined and may embed identifiers.

Only the mapped value appears in the payload and contributes to `rowKey`.

---

## 6. Pseudonymous developer id

There is **no developer email or identity in the local Copilot DB.** The extension mints a
pseudonymous id locally:

- Opaque, stable per developer within an org, salted hash (see the pseudonymization strategy doc).
  Specifically: literal `dev_` prefix + 32 lowercase hex chars (first 16 bytes of
  `HMAC-SHA256(orgSalt, normalizedGitEmail)`), e.g. `dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3`.
- Constrained by the schema to `^dev_[0-9a-f]{32}$`, **exactly 36 characters** — which structurally
  **excludes** an email address or any free-text PII (no `@`, no uppercase, no characters outside
  `[0-9a-f]` after the `dev_` prefix; an email simply cannot satisfy the pattern).
- Used server-side purely as a **distinct-count dimension** for "active developers" and to scope
  developer-activity rows. It is never displayed as a name.

---

## 7. Forbidden fields (rejected by `additionalProperties: false`)

The following MUST NEVER appear anywhere in the payload. Because every object sets
`additionalProperties: false`, the API will **reject the whole batch** if any of them (or any other
unlisted field) is present. This is the raw-field-rejection mechanism and a privacy regression test.

Raw content (12 sensitive `span_attributes` keys — matches the snapshot's `sensitive: true` set):

- `copilot_chat.user_request`
- `gen_ai.input.messages`, `gen_ai.output.messages`
- `gen_ai.system_instructions`
- `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`
- `gen_ai.tool.definitions`, `gen_ai.tool.description`
- `copilot_chat.reasoning_content`
- `copilot_chat.hook_input`, `copilot_chat.hook_output`, `copilot_chat.hook_command`

Raw / sensitive request internals (also `sensitive: true` in the snapshot):

- `copilot_chat.request.options` — flagged sensitive in the captured DB (may embed request
  internals); never shipped.

Identifying / environment data:

- file paths, commit hashes (`copilot_chat.repo.head_commit_hash`)
- machine name, OS username, developer email / `user.email` / `UserId`
- raw session ids, conversation ids, trace/span ids (only the *count* of distinct sessions ships)

Borderline — kept local, NOT shipped:

- `repositoryBranch` (`copilot_chat.repo.head_branch_name`) is **the only borderline field with a
  defined slot**, and it is **omitted by default** (§3). Branch names can encode feature, customer,
  or ticket identifiers, so it ships only when an org explicitly opts in.
- `status_message` (`spans.status_message`) — may echo an error string; kept local, never shipped.
- `error.type` — an error classification; kept local for diagnostics, not part of any v1 bucket
  field. (Error volume reaches the cloud only as the aggregate `errorCount`, see §7.1.)

### 7.1 Success / error semantics

`successCount` and `errorCount` are derived from the OTEL `spans.status_code` (`0`=unset, `1`=ok,
`2`=error):

- **`successCount`** = count of spans with `status_code` ∈ **{0 unset, 1 ok}**.
- **`errorCount`** = count of spans with `status_code` = **2 (error)**.
- These partition the row: `successCount + errorCount = interactionCount`.
- **Error rate** is computed server-side as `errorCount / interactionCount`.

**Treatment of `unset` (0):** `status_code = 0` (unset) is deliberately counted as a **non-error**
(folded into `successCount`), because Copilot leaves many non-`chat` spans (tools, hooks) at the
unset default and treating those as failures would inflate the error rate. There was **no legacy
success/error baseline** to preserve — `LogAnalyticsService` did not compute a success rate — so this
unset-as-success convention is a new, explicit definition rather than a reproduction of prior cloud
behavior. (In the captured snapshot the split is `0`→147, `1`→148, `2`→134.)

---

## 8. Latency histogram (mergeable approximate percentiles)

Averages can be derived from `durationMsSum / interactionCount`, but **percentiles cannot be summed**.
To let the server approximate p95 over an arbitrary time range while still merging buckets, each row
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
- Server-side p95 over a range: sum the `counts` arrays element-wise across all matching rows, then
  walk the cumulative distribution to the bucket containing the 95th percentile and interpolate
  within its `[lowerBound, upperBound]` (the overflow bucket reports `≥ 30000 ms`).

This reproduces `DashboardMetrics.P95LatencyMs` approximately without shipping raw per-span durations.

---

## 9. Distinct counts MUST be computed server-side (critical)

`DashboardMetrics.ActiveRepositories`, `ActiveDevelopers`, and `RepositoryActivitySummary.ActiveDevelopers` /
`UniqueModels` are **distinct counts (`dcount`)** in `LogAnalyticsService`. Distinct counts are **not
additive across time bins**, so they cannot be pre-summed in the bucket measures:

- If developer *D* is active in two adjacent 30-minute bins, those two rows each report
  `distinctDevelopers = 1`. Summing gives **2**, but the true distinct count for the combined range is
  **1**.

Therefore:

- The payload deliberately ships **dimension values** (`pseudonymousDeveloperId` on the envelope,
  `repository`, `model` on each bucket), **not** pre-computed dcounts of them.
- `distinctSessionCount` is included only as **per-row context** and is explicitly flagged
  non-additive; the server must not sum it for a range total.
- The dashboard computes distinct counts **at query time** by counting distinct dimension values
  across the rows in the requested range:
  - `ActiveDevelopers` = `COUNT(DISTINCT pseudonymousDeveloperId)` over rows in range.
  - `ActiveRepositories` = `COUNT(DISTINCT repository)` (excluding `"unknown"`, matching the
    legacy `where Repository != "unknown"`).
  - `UniqueModels` per repo/developer = `COUNT(DISTINCT model)` over that subset.
  - True distinct sessions over a range = `COUNT(DISTINCT session)` — which is why the *count* alone
    is insufficient and `distinctSessionCount` stays per-row context only.

Additive measures (`interactionCount`, token sums, `durationMsSum`, histogram `counts`) **are**
summed across rows; distinct counts are **not**. This split is the core correctness rule of the
aggregate store.

---

## 10. TypeScript interface (producer)

Kept identical in shape to the JSON Schema. The extension emits exactly this object.

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
  bucketDurationSeconds: 1800;    // const 1800 (30 minutes) — global invariant in v1
  repository: string;             // SANITIZED https://{host}/{owner}/{repo} or "unknown"
  repositoryBranch?: string;      // OMITTED by default
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

## 11. C# record (consumer)

Kept identical in shape to the JSON Schema. The dashboard API deserializes into these records and
relies on `additionalProperties: false` (enforced via JSON Schema validation before binding) to
reject unexpected fields. `JsonIgnoreCondition.WhenWritingNull` keeps optional fields omitted.

```csharp
using System.Text.Json.Serialization;

namespace AgentObservability.Dashboard.Models.Aggregates;

public sealed record AggregateBatch
{
    [JsonPropertyName("schemaVersion")]
    public required string SchemaVersion { get; init; } // const "1.0"

    [JsonPropertyName("batchId")]
    public required string BatchId { get; init; }

    [JsonPropertyName("generatedAt")]
    public required DateTimeOffset GeneratedAt { get; init; }

    [JsonPropertyName("toolVersion")]
    public required string ToolVersion { get; init; }

    [JsonPropertyName("pseudonymousDeveloperId")]
    public required string PseudonymousDeveloperId { get; init; }

    [JsonPropertyName("window")]
    public required AggregateWindow Window { get; init; }

    [JsonPropertyName("buckets")]
    public required IReadOnlyList<AggregateBucket> Buckets { get; init; } = [];
}

public sealed record AggregateWindow
{
    [JsonPropertyName("start")]
    public required DateTimeOffset Start { get; init; }

    [JsonPropertyName("end")]
    public required DateTimeOffset End { get; init; }
}

public sealed record AggregateBucket
{
    [JsonPropertyName("rowKey")]
    public required string RowKey { get; init; }

    [JsonPropertyName("bucketStart")]
    public required DateTimeOffset BucketStart { get; init; }

    [JsonPropertyName("bucketDurationSeconds")]
    public required int BucketDurationSeconds { get; init; } // const 1800 (30 min) in v1

    [JsonPropertyName("repository")]
    public required string Repository { get; init; } // SANITIZED https://{host}/{owner}/{repo} or "unknown"

    [JsonPropertyName("repositoryBranch")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RepositoryBranch { get; init; }

    [JsonPropertyName("model")]
    public required string Model { get; init; }

    [JsonPropertyName("agentMode")]
    public required string AgentMode { get; init; }

    [JsonPropertyName("operation")]
    public required string Operation { get; init; } // chat | execute_tool | execute_hook | invoke_agent

    [JsonPropertyName("toolName")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ToolName { get; init; }

    [JsonPropertyName("interactionCount")]
    public required int InteractionCount { get; init; }

    [JsonPropertyName("successCount")]
    public required int SuccessCount { get; init; }

    [JsonPropertyName("errorCount")]
    public required int ErrorCount { get; init; }

    [JsonPropertyName("inputTokens")]
    public required long InputTokens { get; init; }

    [JsonPropertyName("outputTokens")]
    public required long OutputTokens { get; init; }

    [JsonPropertyName("cachedTokens")]
    public required long CachedTokens { get; init; }

    [JsonPropertyName("reasoningTokens")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? ReasoningTokens { get; init; }

    [JsonPropertyName("durationMsSum")]
    public required double DurationMsSum { get; init; }

    [JsonPropertyName("latencyHistogram")]
    public required LatencyHistogram LatencyHistogram { get; init; }

    [JsonPropertyName("distinctSessionCount")]
    public required int DistinctSessionCount { get; init; } // per-row context only; NOT additive

    [JsonPropertyName("lastActivityAtMs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? LastActivityAtMs { get; init; } // optional; Unix epoch ms of latest span start (max over row)
}

public sealed record LatencyHistogram
{
    /// <summary>Must equal [100,250,500,1000,2000,5000,10000,30000].</summary>
    [JsonPropertyName("boundsMs")]
    public required IReadOnlyList<double> BoundsMs { get; init; }

    /// <summary>Length = BoundsMs.Count + 1 (= 9); last element is the +Inf overflow bucket.</summary>
    [JsonPropertyName("counts")]
    public required IReadOnlyList<long> Counts { get; init; }
}
```

---

## 12. Worked example

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

## 13. Tradeoffs chosen

- **30-minute bins (`bucketDurationSeconds` const 1800).** Matches the legacy overview
  `bin(TimeGenerated,30m)` query exactly so no resolution is lost. The width is a **global invariant**,
  not a per-batch field: because both width and alignment are fixed, `rowKey`s for the same wall-clock
  window always collide and upserts converge. Changing the bin width is a breaking change requiring a
  `schemaVersion` bump — never a re-send at a different width.
- **Upsert by `rowKey` (latest-wins), full aggregate per cell (not deltas).** This is the
  authoritative idempotency mechanism; it tolerates retries and overlapping windows. `batchId` is only
  an optimization for byte-identical retries and never authoritative — a repeated `batchId` with
  corrected/fuller buckets still re-applies row upserts. Cost: the extension must emit the complete
  value for a cell each time.
- **Fixed histogram bounds over t-digest/exact percentiles.** Slightly approximate p95, but trivially
  mergeable across rows/developers and tiny on the wire (9 integers). Exactness was not required to
  reproduce `P95LatencyMs`.
- **Distinct dimensions shipped, dcounts computed server-side.** The only correct option (dcounts are
  not additive). Cost: the cloud must store and scan dimension values, not just summed metrics.
- **`repository` as a plain URL in v1, hashing deferred.** Repo URL is org-relevant and explicitly
  allowed; documented as possibly hashed later so consumers do not hard-depend on URL structure.
- **`repositoryBranch` slot defined but omitted by default.** Lets an org opt in without a schema
  change, while defaulting to the privacy-safe choice.
- **`additionalProperties: false` everywhere.** Turns the schema validator into the privacy
  enforcement layer: any raw/forbidden field causes outright rejection rather than silent storage.
```
