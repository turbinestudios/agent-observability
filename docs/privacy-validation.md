# Privacy Validation: Checklist & Enforcement

This document states the **end-to-end privacy guarantee** of Agent Observability
and lists exactly **how each part is enforced and tested** in code. It is the
reference for auditing the privacy-first refactor.

## End-to-end guarantee

> **No raw prompt, response, tool I/O, reasoning, hook, or session content — and
> no file paths, commit hashes, branch names, machine name, OS username, or
> developer email — ever reaches the cloud.** Raw content is readable **only
> locally** inside the VS Code extension. The cloud receives **only** the
> aggregate batch contract, and **only** after explicit, per-developer opt-in.

The guarantee is enforced by **defense in depth**: the client never emits raw
fields, the shared schema rejects unexpected fields, and the server re-validates
and rejects raw/free-text fields even though it does not trust the client.

## Privacy checklist (and where it is enforced)

| # | Control | Where enforced | How it is tested |
|---|---------|----------------|------------------|
| 1 | Extension reads only **safe metadata** for aggregation; raw content is shown **locally only** | `src/extension/.../telemetry/database.ts` (typed safe-metadata queries; the single raw-content read feeds only the local session-detail view) | `telemetry/safety.test.ts`, `telemetry/sessionDetail.test.ts` |
| 2 | Local DB opened **read-only** on a snapshot; source never mutated | `telemetry/snapshot.ts`, `telemetry/database.ts` | `telemetry/safety.test.ts` (writes throw; source stat unchanged) |
| 3 | Aggregate batch contains **no raw-content markers**, no redaction placeholder, no email-shaped string, no `@` in repositories | `aggregate/aggregator.ts` (+ `pseudonymizer.ts`, `repositoryUrl.ts`) | `aggregate/privacy.test.ts` (real fixture, scans every string) |
| 4 | Aggregate batch validates against the strict shared schema — `additionalProperties:false` so unexpected/raw fields are rejected | `schemas/aggregate-batch.schema.json` (shared contract) | `aggregate/privacy.test.ts` test (1) compiles with ajv 2020 `strict:true` and validates |
| 5 | Repository is `unknown` or a sanitized `https?://host/path` URL — no credentials/PII | `telemetry/repositoryUrl.ts` (`REPOSITORY_PATTERN`) + schema pattern | `aggregate/privacy.test.ts` tests (2),(3); `telemetry/repositoryUrl.test.ts` |
| 6 | Developer id is **pseudonymous** (`dev_[0-9a-f]{32}`), salted, irreversible | `aggregate/pseudonymizer.ts`, `secrets/pseudonymize.ts` | `aggregate/privacy.test.ts` test (4); `secrets/pseudonymize.test.ts` |
| 7 | `repositoryBranch` is **omitted by default** and length/charset-capped when present | extension aggregator; server `AggregateBatchValidator` | `aggregate/privacy.test.ts` (branch marker absent); server `ValidatorTests` |
| 8 | Sharing is **opt-in, off by default**; sync blocked unless consent **and** key present | `consent/consentManager.ts`, `consent/syncGate.ts`, package `agentObservability.sync.enabled=false` | `consent/syncGate.test.ts`, `consent/consentDisclosure.test.ts` |
| 9 | API key stored **only** in SecretStorage; never in settings/files/logs | `secrets/secretManager.ts` | `secrets/*` tests; see `docs/architecture/api-auth.md` §2 |
| 10 | Server re-validates the batch and **rejects raw/free-text fields** (defense in depth) | `Services/Ingestion/AggregateBatchValidator.cs` | `ValidatorTests.cs`, `IngestionPipelineTests.cs` |
| 11 | `orgId` derived from the **key record**, never the payload | `Services/Ingestion/IngestionAuthenticator.cs` | `IngestionPipelineTests.cs` |
| 12 | Dashboard query guardrail rejects raw-table/raw-field KQL in aggregate-only mode | `Services/WidgetQueryService.cs` (`GetGuardrailError`) | `WidgetQueryGuardrailTests.cs` |
| 13 | Cloud-side raw deviation polling is **gated off by default** | `Services/AlertEngine.cs` (gated on `WebUx:ExposeRawSessionDetail`, default false) | `Services/AlertEngine.cs` gate + `WebUxOptions` default |

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

### The critical regression test: `aggregate/privacy.test.ts`

This test builds a **real** aggregate batch from real fixture telemetry (the same
read path the extension uses) and proves the contract end-to-end:

1. The batch validates against the strict shared JSON Schema via **ajv 2020**
   (`strict:true`) — proving `additionalProperties:false` holds, so no
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

## Shared contract: `schemas/aggregate-batch.schema.json`

The single shared contract between the TypeScript producer (extension) and the
C# consumer (dashboard API). It sets **`additionalProperties: false` at every
object level**, so the API rejects any unexpected (potentially raw/sensitive)
field. It constrains the dimension grain (30-minute buckets, fixed latency
bounds `[100,250,500,1000,2000,5000,10000,30000]`), the repository pattern, the
`dev_[0-9a-f]{32}` developer id, and the operation enum.

## Server-side enforcement (dashboard)

**The client is never trusted.** Even though the extension produces schema-valid
batches, the server re-checks every rule as defense in depth.

### `AggregateBatchValidator`

Located at
`src/dashboard/AgentObservability.Dashboard/Services/Ingestion/AggregateBatchValidator.cs`.
Re-validates a deserialized batch and rejects (400) on any problem. Key guards:

- **Repository `@`/`?`/`#`/whitespace rejection** — belt-and-suspenders so a
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

### `IngestionAuthenticator`

`orgId` is resolved from the validated **key record**, never from the request
body, so a Team-A key cannot write aggregates attributed to Team-B. Validation
uses `HMAC-SHA256(pepper, secret)` with a constant-time compare and an
indistinguishable-failure (dummy-HMAC) path. See
[`docs/architecture/api-auth.md`](architecture/api-auth.md).

### `WidgetQueryService` guardrail

`GetGuardrailError` rejects any dashboard query that references raw telemetry
tables, raw-content fields, or the raw property/measurement bags **before**
touching Log Analytics, enforcing the aggregate-only contract at execution time.
It is active whenever `WebUx:ExposeRawSessionDetail` is `false` (the default);
when `true` (one-release rollback) the guardrail is bypassed so legacy raw
widgets keep working. Tested by `WidgetQueryGuardrailTests.cs`.

### `AlertEngine` gated off by default

The cloud-side `AlertEngine` ran raw `AppDependencies/Properties[...]` KQL — part
of the retired raw-telemetry world. It is **gated on
`WebUx:ExposeRawSessionDetail`**, which defaults to `false`, so it stays idle and
logs that workflow-deviation detection now runs **locally** in the extension.
Setting `ExposeRawSessionDetail=true` re-enables cloud-side polling for the
one-release rollback window only.

## Rollback note

The single master switch for the raw-vs-aggregate world is
`WebUx:ExposeRawSessionDetail` (default `false`). Flipping it to `true` (plus
`Analytics:Source=Legacy` if needed) re-exposes the legacy raw behavior for one
release. See [`docs/migration.md`](migration.md) §(f). Under the default
configuration, the end-to-end guarantee above holds: no raw prompt/response/
session content reaches the cloud.
