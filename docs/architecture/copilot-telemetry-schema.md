# GitHub Copilot Local Telemetry Schema Reference (`agent-traces.db`)

> Source of truth: `tools/copilot-telemetry/copilot-telemetry-schema.json`
> (a sanitized snapshot captured from a real local `agent-traces.db`).
>
> This document describes the **real** native GitHub Copilot Chat SQLite
> telemetry database, classifies every attribute as safe-for-aggregate vs.
> raw-content (local-only), and maps source columns/attributes to the internal
> model fields.

---

## 1. Overview

GitHub Copilot Chat writes OpenTelemetry-style trace data to a local SQLite
database, `agent-traces.db`. This is the **local raw source** for the VS Code
extension and the desktop app, which read it through the shared core package. They
read it **read-only** and never upload raw content; only opt-in aggregates leave
the machine.

Facts validated against the snapshot:

| Property | Value |
| --- | --- |
| Database file | `agent-traces.db` |
| `schema_version` | `1` |
| `journal_mode` | `wal` (Write-Ahead Logging) |
| Core tables | `spans`, `span_attributes`, `span_events` |
| Convenience view | `sessions` |
| Bookkeeping table | `schema_version` (single row) |
| Snapshot row counts | `spans`=429, `span_attributes`=5867, `span_events`=179 |

The data model is a flattened OTEL trace:

- **`spans`**: one row per operation, with hot/non-sensitive metadata
  promoted to typed columns.
- **`span_attributes`**: open-ended key/value side table (the OTEL attribute
  bag). **This is where all raw, sensitive content lives.**
- **`span_events`**: timestamped events attached to a span (e.g. streaming
  milestones).
- **`sessions`**: a `VIEW` that rolls spans up into per-session summaries.

A span's `operation_name` is one of four values (snapshot distribution):

| `operation_name` | Count | Meaning |
| --- | --- | --- |
| `chat` | 149 | An LLM request/response turn. Carries token usage + model. |
| `execute_hook` | 143 | A Copilot lifecycle hook execution. |
| `execute_tool` | 120 | A tool/function call (read_file, run_in_terminal, …). |
| `invoke_agent` | 17 | An agent invocation. **Repo metadata lives here.** |

> Note: OTEL attribute names use the `gen_ai.*` convention; the SQLite layer
> also promotes some of them into native `spans` columns (e.g.
> `gen_ai.usage.input_tokens` → `spans.input_tokens`). When a value exists in
> both places they agree; prefer the typed `spans` column for aggregation.

---

## 2. Table: `spans`

One row per operation. All columns are **non-sensitive metadata** and are
safe to aggregate.

```sql
CREATE TABLE spans (
    span_id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_span_id TEXT,
    name TEXT NOT NULL, start_time_ms INTEGER NOT NULL, end_time_ms INTEGER NOT NULL,
    status_code INTEGER NOT NULL DEFAULT 0, status_message TEXT,
    operation_name TEXT, provider_name TEXT, agent_name TEXT, conversation_id TEXT,
    request_model TEXT, response_model TEXT,
    input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
    tool_name TEXT, tool_call_id TEXT, tool_type TEXT,
    chat_session_id TEXT, turn_index INTEGER, ttft_ms REAL
);
```

| Column | Type | Null | Description |
| --- | --- | --- | --- |
| `span_id` | TEXT | PK | Unique span identifier. |
| `trace_id` | TEXT | not null | OTEL trace id grouping related spans. |
| `parent_span_id` | TEXT | nullable | Parent span; null for roots. Use to build the call tree. |
| `name` | TEXT | not null | Human-readable span name. |
| `start_time_ms` | INTEGER | not null | Start time, **epoch milliseconds**. |
| `end_time_ms` | INTEGER | not null | End time, epoch ms. Duration = `end - start`. |
| `status_code` | INTEGER | not null | OTEL status: `0`=unset, `1`=ok, `2`=error. |
| `status_message` | TEXT | nullable | Optional status detail. May echo an error string; treat as borderline, do not upload verbatim. |
| `operation_name` | TEXT | nullable | One of `chat` / `execute_tool` / `execute_hook` / `invoke_agent`. |
| `provider_name` | TEXT | nullable | LLM provider, e.g. `github`. **Null on non-`chat` spans** (263 null vs 166 `github` in snapshot). |
| `agent_name` | TEXT | nullable | Agent name (max len 31), e.g. the active chat agent. |
| `conversation_id` | TEXT | nullable | Conversation id (UUID, len 36). Primary session key. |
| `request_model` | TEXT | nullable | Requested model id (e.g. on `chat` spans). |
| `response_model` | TEXT | nullable | Model that actually responded. Used as the session `model`. |
| `input_tokens` | INTEGER | nullable | Prompt tokens for the call (`chat` spans). |
| `output_tokens` | INTEGER | nullable | Completion tokens. |
| `cached_tokens` | INTEGER | nullable | Cache-read input tokens. |
| `reasoning_tokens` | INTEGER | nullable | Reasoning/thinking tokens. |
| `tool_name` | TEXT | nullable | Tool invoked (`execute_tool` spans), e.g. `read_file`. |
| `tool_call_id` | TEXT | nullable | Tool call correlation id. |
| `tool_type` | TEXT | nullable | Tool category (max len 8). |
| `chat_session_id` | TEXT | nullable | Chat session id (UUID). Fallback session key. |
| `turn_index` | INTEGER | nullable | Zero-based turn ordinal within a session. |
| `ttft_ms` | REAL | nullable | Time to first token, milliseconds (`chat` spans). |

Observed `tool_name` distribution (top values): `read_file` (50),
`run_in_terminal` (30), `list_dir` (11), `replace_string_in_file` (7),
`grep_search` (6), `manage_todo_list` (5), `multi_replace_string_in_file` (4),
`runSubagent` (2), `file_search` (2), `create_file` (2), `semantic_search` (1).

`status_code` distribution: `0` (147), `1` (148), `2` (134).

---

## 3. Table: `span_attributes`

The open-ended OTEL attribute bag: a tall key/value table keyed by
`(span_id, key)`. **Every raw/sensitive payload lives here.** See
[Section 6](#6-attribute-classification-safe-vs-raw) for the full
SAFE vs RAW classification.

```sql
CREATE TABLE span_attributes (
    span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
    key TEXT NOT NULL, value TEXT,
    PRIMARY KEY (span_id, key)
);
```

| Column | Type | Description |
| --- | --- | --- |
| `span_id` | TEXT | FK → `spans.span_id` (cascade delete). |
| `key` | TEXT | Attribute name (e.g. `gen_ai.usage.input_tokens`, `copilot_chat.user_request`). |
| `value` | TEXT | Attribute value, always stored as text. May be tiny (a token count) or huge (131 KB of tool definitions). |

`value` is untyped text; numeric attributes must be parsed. Some values are
JSON blobs (e.g. `gen_ai.input.messages`, `copilot_chat.request.options`).

---

## 4. Table: `span_events`

Timestamped events attached to a span.

```sql
CREATE TABLE span_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    span_id TEXT NOT NULL REFERENCES spans(span_id) ON DELETE CASCADE,
    name TEXT NOT NULL, timestamp_ms INTEGER NOT NULL, attributes TEXT
);
```

| Column | Type | Description |
| --- | --- | --- |
| `id` | INTEGER | Auto-increment PK. |
| `span_id` | TEXT | FK → `spans.span_id` (cascade delete). |
| `name` | TEXT | Event name. |
| `timestamp_ms` | INTEGER | Event time, epoch ms. |
| `attributes` | TEXT | Free-form JSON attribute blob. **Treat as RAW-CONTENT**: may embed prompt/tool payloads; not used by aggregates. |

---

## 5. View: `sessions`

A convenience rollup of `spans` into one row per session. The session key is
`COALESCE(conversation_id, chat_session_id)`, i.e. prefer the
`conversation_id`, fall back to `chat_session_id`.

```sql
CREATE VIEW sessions AS
SELECT
    COALESCE(conversation_id, chat_session_id) AS session_id,
    agent_name,
    response_model AS model,
    MIN(start_time_ms) AS started_at,
    MAX(end_time_ms) AS ended_at,
    MAX(end_time_ms) - MIN(start_time_ms) AS duration_ms,
    COUNT(*) AS span_count,
    SUM(CASE WHEN operation_name = 'chat' THEN 1 ELSE 0 END) AS llm_calls,
    SUM(CASE WHEN operation_name = 'execute_tool' THEN 1 ELSE 0 END) AS tool_calls,
    SUM(CASE WHEN operation_name = 'chat' THEN input_tokens ELSE 0 END) AS total_input_tokens,
    SUM(CASE WHEN operation_name = 'chat' THEN output_tokens ELSE 0 END) AS total_output_tokens,
    SUM(CASE WHEN operation_name = 'chat' THEN cached_tokens ELSE 0 END) AS total_cached_tokens
FROM spans
WHERE COALESCE(conversation_id, chat_session_id) IS NOT NULL
GROUP BY COALESCE(conversation_id, chat_session_id);
```

| Column | Source / formula | Description |
| --- | --- | --- |
| `session_id` | `COALESCE(conversation_id, chat_session_id)` | Stable per-session key. |
| `agent_name` | `spans.agent_name` | Agent for the session. |
| `model` | `spans.response_model` | Responding model. |
| `started_at` | `MIN(start_time_ms)` | Session start, epoch ms. |
| `ended_at` | `MAX(end_time_ms)` | Session end, epoch ms. |
| `duration_ms` | `MAX(end) - MIN(start)` | Wall-clock session duration. |
| `span_count` | `COUNT(*)` | Total spans in session. |
| `llm_calls` | count of `chat` spans | Number of LLM turns. |
| `tool_calls` | count of `execute_tool` spans | Number of tool calls. |
| `total_input_tokens` | sum over `chat` spans | Prompt tokens (chat only). |
| `total_output_tokens` | sum over `chat` spans | Completion tokens (chat only). |
| `total_cached_tokens` | sum over `chat` spans | Cache-read tokens (chat only). |

> Token sums deliberately count **only `chat` spans** so tool/hook/agent spans
> (which carry no token usage) do not distort totals.

---

## 6. Attribute Classification: SAFE vs RAW

This is the privacy contract. Every `span_attributes.key` observed
in the snapshot is classified below.

- **SAFE-FOR-AGGREGATE:** non-sensitive metadata; may feed cloud aggregate
  buckets (after pseudonymization where relevant).
- **RAW-CONTENT (local-only):** prompts, completions, tool I/O, instructions.
  **MUST NEVER leave the machine.** Used only inside the extension for local
  session detail.

### 6.1 SAFE-FOR-AGGREGATE keys

| Attribute key | Occ. | Max len | Notes |
| --- | --- | --- | --- |
| `gen_ai.operation.name` | 429 | 12 | Operation type. Mirrors `spans.operation_name`. |
| `copilot_chat.chat_session_id` | 318 | 36 | Chat session UUID. |
| `gen_ai.request.model` | 166 | 31 | Requested model id. |
| `gen_ai.provider.name` | 166 | 6 | Provider (`github`). |
| `gen_ai.conversation.id` | 166 | 36 | Conversation UUID (primary session key). |
| `gen_ai.agent.name` | 166 | 31 | Agent name. |
| `gen_ai.usage.output_tokens` | 164 | 4 | Completion tokens. |
| `gen_ai.usage.input_tokens` | 164 | 6 | Prompt tokens. |
| `gen_ai.response.model` | 163 | 31 | Responding model id. |
| `gen_ai.response.finish_reasons` | 149 | 9 | e.g. `stop`, `length`. |
| `gen_ai.request.max_tokens` | 149 | 5 | Request cap. |
| `copilot_chat.request.shape` | 149 | 36 | Request shape id. |
| `copilot_chat.request.max_prompt_tokens` | 149 | 6 | Prompt token budget. |
| `gen_ai.response.id` | 147 | 36 | Provider response id. |
| `copilot_chat.time_to_first_token` | 147 | 4 | TTFT ms. Mirrors `spans.ttft_ms`. |
| `copilot_chat.server_request_id` | 147 | 36 | Server request id. |
| `copilot_chat.hook_type` | 143 | 11 | Hook category. |
| `copilot_chat.hook_result_kind` | 143 | 18 | Hook result classification. |
| `copilot_chat.hook_exit_code` | 126 | 1 | Hook process exit code. |
| `gen_ai.tool.type` | 120 | 8 | Tool category. |
| `gen_ai.tool.name` | 120 | 28 | Tool name. |
| `gen_ai.tool.call.id` | 120 | 35 | Tool call id. |
| `gen_ai.usage.cache_read.input_tokens` | 96 | 6 | Cache-read tokens. |
| `copilot_chat.session_id` | 84 | 36 | Session UUID. |
| `gen_ai.usage.cache_creation.input_tokens` | 82 | 5 | Cache-creation tokens. |
| `gen_ai.request.top_p` | 82 | 1 | Sampling param. |
| `gen_ai.request.temperature` | 82 | 3 | Sampling param. |
| `copilot_chat.copilot_usage_nano_aiu` | 66 | 1 | Usage units. |
| `copilot_chat.turn_count` | 17 | 2 | Turns in session. |
| `copilot_chat.repo.remote_url` | 17 | 54 | **Repository URL, SPARSE.** See [Section 8](#8-repository-by-session-resolution-sparse). |
| `copilot_chat.parent_chat_session_id` | 16 | 36 | Parent session link (subagents). |
| `copilot_chat.debug_log_label` | 16 | 26 | Debug label. |
| `copilot_chat.mode_name` | 14 | 14 | Agent mode (e.g. `agent`, `ask`). |
| `error.type` | 8 | 10 | Error classification (on error spans). |

### 6.2 BORDERLINE: local-only, do NOT upload

These are non-prompt metadata but are still developer/workspace-identifying.
Keep local; exclude from cloud aggregates.

| Attribute key | Occ. | Max len | Why excluded |
| --- | --- | --- | --- |
| `copilot_chat.repo.head_commit_hash` | 17 | 40 | Commit hash, forbidden from cloud. |
| `copilot_chat.repo.head_branch_name` | 17 | 4 | Branch name, optional/borderline; do not upload. |
| `copilot_chat.request.options` | 149 | 429 | Flagged sensitive in snapshot; may embed request internals. |

> Also forbidden from cloud regardless of source: file paths, machine name, OS
> username, developer email. **There is no developer email/identity column in
> this DB**; the extension mints a pseudonymous developer id instead.

### 6.3 RAW-CONTENT keys (local-only, MUST NEVER leave the machine)

| Attribute key | Occ. | Max len | Content |
| --- | --- | --- | --- |
| `gen_ai.input.messages` | 166 | 87,934 | Full prompt message array. |
| `copilot_chat.user_request` | 166 | 17,595 | The user's raw request text. |
| `gen_ai.output.messages` | 162 | 4,656 | Model completion messages. |
| `gen_ai.system_instructions` | 149 | 23,044 | System prompt / instructions. |
| `gen_ai.tool.description` | 120 | 4,331 | Tool definition description. |
| `gen_ai.tool.call.arguments` | 120 | 3,601 | Tool call arguments. |
| `gen_ai.tool.call.result` | 119 | 55,271 | Tool call result (file contents, command output). |
| `gen_ai.tool.definitions` | 84 | 131,129 | Full tool/function schemas. |
| `copilot_chat.reasoning_content` | 17 | 8,182 | Model reasoning/thinking text. |
| `copilot_chat.hook_input` | 143 | 56,592 | Hook input payload. |
| `copilot_chat.hook_command` | 143 | 73 | Hook command line. |
| `copilot_chat.hook_output` | 4 | 298 | Hook output payload. |

> Privacy rule of thumb: anything containing prompt text, completion text,
> tool arguments/results, tool/function definitions, hook input/output/command,
> or reasoning content is RAW-CONTENT. The aggregate engine must
> operate **only** on SAFE columns and never read RAW keys into any payload.

---

## 7. Read Strategy: WAL / Locking Behavior

`agent-traces.db` runs in **WAL (Write-Ahead Logging) mode** and is typically
**open and being written by VS Code / the Copilot extension** while the
observability extension wants to read it. In WAL mode the live database is
split across three files:

- `agent-traces.db`: the main database file.
- `agent-traces.db-wal`: the write-ahead log holding recent, not-yet-
  checkpointed commits.
- `agent-traces.db-shm`: the shared-memory index for the WAL.

**The most recent committed data may live only in the `-wal` file**, not yet
merged into the main `.db`. Reading the `.db` alone can therefore return a
stale snapshot, and opening the live file in place risks lock contention with
Copilot's writer.

### Adopted strategy: snapshot-copy + READ-ONLY open

1. Copy all three sidecar files together (`*.db`, `*.db-wal`, `*.db-shm`) to
   a private temp directory.
2. Open the **copied** `.db` with a **read-only** connection
   (e.g. `mode=ro` / `SQLITE_OPEN_READONLY`).
3. Read, then delete the temp copy.

This is implemented in `src/core/agent-observability-core/src/telemetry/snapshot.ts`. One
extra step applies there: the bundled SQLite driver (node-sqlite3-wasm) cannot open a file
flagged for WAL mode, so the code folds the copy's committed `-wal` frames into the copy's
main file and rewrites its header to rollback-journal mode before opening it. Only the
copy is changed; the original file is never opened.

Rationale:

- **Consistent snapshot including WAL:** copying the `-wal` and `-shm`
  alongside the `.db` lets SQLite replay the WAL on first open, so the reader
  sees the latest committed state, not a stale checkpoint.
- **Zero lock contention:** the live DB owned by VS Code is never opened by
  us; the writer is never blocked and we never wait on its locks.
- **Zero write risk:** read-only mode plus operating on a disposable copy
  guarantees we can never modify, checkpoint, or truncate Copilot's real DB.

> Practical notes: copy the sidecars as close together in time as possible to
> minimize tearing; if the `-wal`/`-shm` are absent (DB was cleanly
> checkpointed), copying just the `.db` is sufficient. Never issue
> `PRAGMA wal_checkpoint` or any write against the original file.

---

## 8. Repository-by-Session Resolution (sparse)

`copilot_chat.repo.remote_url` is **sparse**: only 17 of 429 spans carry it
(it appears on `invoke_agent` spans, not on every `chat`/`tool`/`hook` span).
A naive per-span read would label most activity as `unknown`. Repository must
therefore be **resolved per session** and back-filled onto every span in that
session. The earlier cloud dashboard (`LogAnalyticsService`, since removed) used the
same pattern in KQL.

### Earlier cloud pattern (KQL, for reference)

```kql
let RepoBySession = AppDependencies
| where isnotempty(Properties["copilot_chat.repo.remote_url"])
| summarize RepoUrl=take_any(tostring(Properties["copilot_chat.repo.remote_url"]))
    by SessionId=tostring(Properties["session.id"]);
AppDependencies
| extend SessionId=tostring(Properties["session.id"])
| join kind=leftouter RepoBySession on SessionId
| extend Repository=coalesce(RepoUrl, tostring(Properties["copilot_chat.repo.remote_url"]), "unknown")
```

### Local replication (SQLite)

Build a `(session_id → repo_url)` lookup from the sparse spans that have a
URL, then `LEFT JOIN` it onto every span by session key, coalescing to the
span's own URL and finally `'unknown'`:

```sql
WITH repo_by_session AS (
    SELECT COALESCE(s.conversation_id, s.chat_session_id) AS session_id,
           MAX(a.value) AS repo_url_raw       -- take_any: one URL per session (STILL RAW)
    FROM spans s
    JOIN span_attributes a
      ON a.span_id = s.span_id
     AND a.key = 'copilot_chat.repo.remote_url'
    WHERE a.value IS NOT NULL AND a.value <> ''
    GROUP BY COALESCE(s.conversation_id, s.chat_session_id)
)
SELECT s.*,
       COALESCE(r.repo_url_raw, 'unknown') AS repository_raw   -- NOT yet cloud-safe
FROM spans s
LEFT JOIN repo_by_session r
  ON r.session_id = COALESCE(s.conversation_id, s.chat_session_id);
```

> The COALESCE / `MAX(value)` / take_any step above resolves a **raw** remote URL
> (`repository_raw`). It is **NOT** yet safe to bucket or ship. A raw git remote
> can embed credentials (e.g. `https://user:token@host/...`,
> `https://x-access-token:ghp_...@host/...`), query strings, fragments, or a
> `.git` suffix, any of which would leak a PAT/credential to the cloud.

#### MANDATORY sanitization step (privacy-critical)

Before `repository_raw` may be used as a bucket dimension or placed in any
outgoing aggregate, the extension MUST normalize it to canonical
`https://{host}/{owner}/{repo}` form:

- **Strip userinfo:** drop any `user:token@` / `x-access-token@` segment.
- **Strip query (`?…`) and fragment (`#…`).**
- **Drop a trailing `.git`** suffix.
- **Convert SSH remotes:** `git@host:owner/repo` and
  `ssh://git@host/owner/repo` → `https://host/owner/repo`.
- **Fallback:** anything that cannot be normalized to the canonical host/path
  form becomes the literal `'unknown'`.

This is enforced downstream by the aggregate batch schema: the `repository`
field pattern `^(unknown|https?://[A-Za-z0-9.\-]+(:[0-9]+)?/[^\s@?#]+)$` forbids
`@`, `?`, `#`, and whitespace, so a credential-bearing remote **cannot** pass
validation, and the whole batch is rejected if sanitization is skipped. See
`aggregate-payload-schema-v1.md` §4.1.

Key points:
- Session key is `COALESCE(conversation_id, chat_session_id)`, identical to
  the `sessions` view and the cloud `session.id` join key.
- `MAX(value)` plays the role of KQL `take_any` (one stable URL per session).
- The resolved URL is **sanitized (mandatory)** before bucketing/upload.
- Spans whose session never recorded a URL resolve to `'unknown'`.
- The earlier cloud queries additionally filtered out `Repository == "unknown"` for
  repository/overview rollups; mirror that filter locally where appropriate.

---

## 9. Schema Mapping Table (source → internal model)

The internal models are TypeScript interfaces in
`src/core/agent-observability-core/src/telemetry/models.ts`, built from the
**local** DB. The tables below list fields by concept; the TypeScript fields use
camelCase names and units in the name (for example `timestampMs`, `durationMs`).
There is no developer email: where the dashboard needs a developer, it gets a
**pseudonymous developer id** minted by the extension (a salted hash, defined in
[`pseudonymization-strategy.md`](pseudonymization-strategy.md)).

### 9.1 Interaction (one span) → `Interaction` / `SessionTimelineEntry`

| Internal field | Local source | Notes |
| --- | --- | --- |
| `Timestamp` | `spans.start_time_ms` | Epoch ms → `DateTimeOffset`. |
| `Repository` | resolved per session (Section 8) | sparse `copilot_chat.repo.remote_url`, **sanitized (mandatory, Section 8)** before any cloud use, else `unknown`. |
| `Agent` | `spans.agent_name` (attr `gen_ai.agent.name`) | default `copilot`. |
| `ToolName` | `spans.tool_name` (attr `gen_ai.tool.name`) | `execute_tool` spans; else `name`. |
| `Model` | `spans.request_model` / `response_model` | attrs `gen_ai.request.model` / `gen_ai.response.model`. |
| `DurationMs` | `spans.end_time_ms - spans.start_time_ms` | replaces cloud `DurationMs`. |
| `Success` | `spans.status_code` | `true` when `status_code` ∈ {0 unset, 1 ok}; `false` only when `2` (error). **Unset (0) is treated as a non-error**; there was no legacy success baseline (`LogAnalyticsService` computed no success rate), so this is a new explicit definition. Aggregated as `successCount` / `errorCount`. |
| `AgentMode` | attr `copilot_chat.mode_name` | default `default`. |
| `UserRequest` | attr `copilot_chat.user_request` | **RAW-CONTENT, local-only.** Local session detail only (`SessionTimelineEntry`); never aggregated/uploaded. |

> `SessionTimelineEntry` is **local-only** (it includes `userRequest`).
> `Interaction` carries no raw content and is the basis for deviation
> detection.

### 9.2 Session summary (`sessions` view) → `SessionSummary`

| Internal field | Local source | Notes |
| --- | --- | --- |
| `SessionId` | `sessions.session_id` | `COALESCE(conversation_id, chat_session_id)`. |
| `StartTime` | `sessions.started_at` | epoch ms → `DateTimeOffset`. |
| `EndTime` | `sessions.ended_at` | epoch ms → `DateTimeOffset`. |
| `RequestCount` | `sessions.span_count` (or `llm_calls`) | choose per UX; cloud used per-span count. |
| `AgentModes` | distinct attr `copilot_chat.mode_name` per session | set → joined string. |
| `Repository` (lookup) | resolved per session (Section 8) | used to list sessions by repo. |

### 9.3 Aggregate buckets → cloud-safe fields (feeds `DashboardMetrics`, etc.)

Aggregates are computed locally over **SAFE** columns only, then time-binned.
The extension ships the bucket measures defined in
[`aggregate-payload-schema-v1.md`](aggregate-payload-schema-v1.md), and the dashboard
computes the fields below from them at query time. Each field and its local source:

| Aggregate field | Local source / formula | Maps to cloud model |
| --- | --- | --- |
| `TotalRequests` | `COUNT(*)` of spans in bin | `DashboardMetrics.TotalRequests` |
| `AverageLatencyMs` | `AVG(end_time_ms - start_time_ms)` | `DashboardMetrics.AverageLatencyMs` |
| `P95LatencyMs` | p95 of per-span duration | `DashboardMetrics.P95LatencyMs` |
| `ActiveRepositories` | distinct resolved repository | `DashboardMetrics.ActiveRepositories` |
| `ActiveDevelopers` | distinct pseudonymous developer id | `DashboardMetrics.ActiveDevelopers` |
| `RequestVolume` (time series) | `COUNT(*)` by 30-min `bin(start_time_ms)` | `DashboardMetrics.RequestVolume` (`TimeSeriesPoint`) |
| `ModelBreakdown` | `COUNT(*)` by `request_model`/`response_model` | `DashboardMetrics.ModelBreakdown` (`NamedValue`) |
| model `InputTokens` | `SUM(input_tokens)` (chat spans) by model | `NamedValue.SecondaryValue` (model usage) |
| model `OutputTokens` | `SUM(output_tokens)` (chat spans) by model | `NamedValue.SecondaryValue` (model usage) |
| per-developer `Requests` | `COUNT(*)` by developer id (+ repository) | `DeveloperActivitySummary.Requests` |
| per-developer `AverageLatencyMs` | `AVG(duration)` by developer id | `DeveloperActivitySummary.AverageLatencyMs` |
| per-developer `UniqueModels` | `dcount(model)` by developer id | `DeveloperActivitySummary.UniqueModels` |
| per-developer `LastSeen` | `MAX(start_time_ms)` by developer id | `DeveloperActivitySummary.LastSeen` |
| per-repo `Requests` | `COUNT(*)` by repository | `RepositoryActivitySummary.Requests` |
| per-repo `ActiveDevelopers` | `dcount(developer id)` by repository | `RepositoryActivitySummary.ActiveDevelopers` |
| per-repo `AverageLatencyMs` | `AVG(duration)` by repository | `RepositoryActivitySummary.AverageLatencyMs` |
| per-repo `UniqueModels` | `dcount(model)` by repository | `RepositoryActivitySummary.UniqueModels` |

Token aggregates follow the `sessions` view convention: **count token columns
only on `chat` spans** (other operations have null/zero tokens).

> **Privacy gate (must hold for every aggregate field above):** the value is
> derived purely from SAFE columns/attributes in Section 6.1, a duration math
> derived from `start_time_ms`/`end_time_ms`, a count/distinct-count, or the
> minted pseudonymous developer id. No field reads a RAW-CONTENT or BORDERLINE
> key, a file path, a commit hash, a branch name, a machine name, an OS
> username, or a developer email.

---

## 10. Source-of-truth pointers

- Machine-readable snapshot: `tools/copilot-telemetry/copilot-telemetry-schema.json`
- Internal models: `src/core/agent-observability-core/src/telemetry/models.ts`
- Snapshot reader: `src/core/agent-observability-core/src/telemetry/snapshot.ts`
- Dashboard models filled from aggregates: `src/dashboard/AgentObservability.Dashboard/Models/DashboardMetrics.cs`
