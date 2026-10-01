# Dashboard Access and Organization API Keys

Status: Implemented. Key check: `src/dashboard/AgentObservability.Dashboard/Services/Ingestion/IngestionAuthenticator.cs`. Key issuance: `infra/scripts/New-IngestionApiKey.ps1`. Dashboard sign-in: `infra/modules/dashboard-app.bicep`.

## Purpose

The dashboard has two kinds of callers:

- **People** opening the dashboard pages in a browser.
- **Programs**: the VS Code extension, which uploads opt-in, aggregated, non-sensitive statistics, and the autonomous-agent OTLP relay, where a cloud agent pushes traces and the extension pulls them.

This document describes how each is authenticated, and how the **organization API key** used by programs is issued, stored, sent, checked, rotated and revoked. It describes what the code does today. Section 8 lists things that are deliberately **not** implemented.

### Privacy boundary

Authentication does not change what is sent. Raw content that must never leave the developer machine (`copilot_chat.user_request`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`/`description`, `copilot_chat.reasoning_content`, `copilot_chat.hook_input`/`hook_output`/`hook_command`, `copilot_chat.request.options`, plus file paths, commit hashes, machine name, OS username, and developer email) is excluded by the aggregate engine, whatever key is used. The full forbidden-fields list is in [`aggregate-payload-schema-v1.md`](aggregate-payload-schema-v1.md) §7. The API key controls *who may submit data for an org*, not *what* that data may contain.

The relay endpoints are a separate path: they carry raw OTLP produced by autonomous agents running in the cloud, stored as-is per org, not data from developer machines.

---

## 1. Dashboard pages: Entra ID sign-in

The dashboard app contains no sign-in code of its own (`Program.cs` registers no authentication). Sign-in for the pages is provided by **Azure Container Apps built-in authentication** with **Entra ID**, configured by the `authConfigs` resource in [`infra/modules/dashboard-app.bicep`](../../infra/modules/dashboard-app.bicep).

- It is **only switched on when the `dashboardAuthClientId` parameter is set** (in [`infra/main.bicep`](../../infra/main.bicep), read from the `DASHBOARD_AUTH_CLIENT_ID` environment variable by [`infra/parameters.bicepparam`](../../infra/parameters.bicepparam)), together with its client secret, `dashboardAuthClientSecret` / `DASHBOARD_AUTH_CLIENT_SECRET`. The tenant defaults to the subscription's tenant.
- When it is on, a browser request without a session is redirected to the Entra ID sign-in page.
- `/api/ingest/*` and `/agent-otlp/*` are **excluded** from sign-in. They are called by the extension and by agents, not by people, and they authenticate with an org API key themselves (sections 2 to 6).
- Who may sign in is decided by the Entra ID app registration (for example, by requiring user assignment). The dashboard itself has no roles and no per-user checks: every signed-in user sees the same data. Which org's data the pages show is set by the `Analytics:OrgId` setting (empty means all orgs).

> **Without `dashboardAuthClientId`, sign-in is off and the dashboard pages are open to anyone who has the URL.** The container app's ingress is external, so any deployment reachable from the internet must set this parameter and its client secret.

---

## 2. Endpoints that use the org API key

| Endpoint | Called by | Purpose |
|---|---|---|
| `POST /api/ingest/aggregate` | VS Code extension | Aggregate batch ([`aggregate-payload-schema-v1.md`](aggregate-payload-schema-v1.md)) |
| `POST /api/ingest/context-insights` | VS Code extension | Context-insights batch ([`context-insights-schema-v1.md`](context-insights-schema-v1.md)) |
| `POST /api/ingest/status` | VS Code extension | Small sync status report |
| `POST /agent-otlp/v1/traces` | Autonomous agent (stock OTLP/HTTP exporter, JSON) | Push one raw OTLP batch |
| `GET /agent-otlp/batches`, `GET /agent-otlp/batches/{id}` | VS Code extension | List and fetch the org's relay batches |

All of these use the same `IngestionAuthenticator` and the same key store. `GET /api/ingest/health` and `GET /agent-otlp/health` need no key and return only `{ "enabled": true|false }`.

Each group has an on/off switch. `Ingestion:Enabled` (default `true`) controls `/api/ingest/*`. `AgentRelay:Enabled` (default `false` in the app, set to `true` by the infra template's `agentRelayEnabled` parameter) controls `/agent-otlp/*`. A switched-off endpoint answers **503**.

---

## 3. Key format

The API key is an **opaque bearer token**. It carries no payload and is not a JWT: it is a random secret that the server maps to an organization.

```
aoa_<keyId>_<secret>
```

| Segment   | As issued by `New-IngestionApiKey.ps1` | Purpose |
|-----------|----------------------------------------|---------|
| `aoa_`    | Fixed prefix | Easy to spot in logs, secret scanners and accidental commits. |
| `<keyId>` | 5 random bytes, as 10 lowercase hex characters | Public, non-secret lookup handle for the stored record. |
| `<secret>`| 32 random bytes (256 bits), as 64 lowercase hex characters | The actual secret. |

How the server parses it: the token must start with `aoa_`; the `keyId` is everything up to the next underscore, and the `secret` is the rest. Both must be non-empty. Clients treat the whole string as opaque and send it unchanged. The extension only checks that a pasted key starts with `aoa_`.

The plaintext key is printed **once**, by the issuing script. It is not stored anywhere on the server and cannot be recovered.

---

## 4. Storage

### Client side

- The VS Code extension stores the key **only** in VS Code **SecretStorage** (backed by the OS keychain, Credential Manager or libsecret), through the **Agent Observability: Set Organization API Key** command.
- It is never written to `settings.json`, workspace settings or any other file, and never logged or shown. The Sync view only says whether a key is stored.
- The relay pull uses its own SecretStorage entry, set with **Copilot (Autonomous): Set relay token**. To the server it is an org API key like any other.
- The dashboard address is the user setting **`agentObservability.sync.dashboardUrl`**. It is empty by default, accepts only `https://` addresses, and has `application` scope, so it can only be set in user settings and never by a workspace. A repository therefore cannot redirect your key to another server.
- Sync is blocked while consent is off, no key is stored, or no dashboard address is set.
- The desktop app does not upload to the dashboard.

### Server side

- The server **never stores the plaintext key**. Key records live in the Azure Table `IngestionApiKeys`:

  | Field          | Notes |
  |----------------|-------|
  | `PartitionKey` | `apikey` |
  | `RowKey`       | `keyId` (the public lookup handle from the token) |
  | `OrgId`        | Organization this key authenticates as. **Taken from here, never from the request body.** |
  | `SecretHashHex`| Lowercase hex of `HMAC-SHA256(pepper, secret)` |
  | `Algo`         | `HMAC-SHA256`. Recorded for a future change of scheme; it is the only scheme the server supports today. |
  | `Status`       | `active` enables the key. Any other value (for example `revoked`) disables it. |
  | `CreatedAt`    | Written by the issuing script. Not read by the server. |
  | `Label`        | Optional description, written by the issuing script. Not read by the server. |

- **Hashing:** `SecretHashHex = HMAC-SHA256(pepper, secret)`, where the HMAC message is the secret segment alone. Because the secret already has 256 bits of random entropy, a fast keyed hash is enough and no slow password hash is needed. The **pepper** is the `Ingestion:KeyPepper` setting. In Azure it is kept in the Key Vault secret `ingestion-key-pepper` and passed to the container app as a secret. It is not stored in the table, so a leak of the table alone does not allow offline guessing. Anything that issues keys must use the same construction, or the stored hashes will not match.
- **Local development:** when no table storage is configured, `ConfigApiKeyStore` reads keys from the `Ingestion:ApiKeys` configuration section instead. Each entry gives either a precomputed `SecretHashHex` or, for development only, a plaintext `Secret` that is hashed at startup with a logged warning.

---

## 5. Transport

- **HTTPS only.** The container app ingress sets `allowInsecure: false`, and the app adds HTTPS redirection, plus HSTS outside the Development environment. The extension refuses a dashboard address that is not `https://`.
- The key is sent in the standard **`Authorization: Bearer <key>`** header:

  ```
  POST /api/ingest/aggregate HTTP/1.1
  Host: dashboard.example.com
  Authorization: Bearer aoa_7f3a9c2e01_qx4k...
  Content-Type: application/json
  ```

- The key is never put in the URL or query string (proxies, gateways and browser history log URLs) or in a cookie.
- No other header is accepted.

### Why `Authorization: Bearer` instead of a custom header

- **Standard meaning.** RFC 6750 Bearer is the well-known "having this token authorizes the request" model, which is exactly this case. Tools, SDKs and gateways already treat `Authorization` specially, and a stock OTLP exporter can send it through `OTEL_EXPORTER_OTLP_HEADERS`.
- **Safer by default.** Reverse proxies, API gateways and logging frameworks usually redact `Authorization`, while custom headers such as `X-Api-Key` are often logged in plaintext unless every layer is configured to scrub them.

---

## 6. Server check

On each request to an endpoint in section 2:

1. **Parse.** Read the `Authorization` header. Require the `Bearer ` scheme and the `aoa_` prefix, and split out `keyId` and `secret`. Anything else fails.
2. **Look up by `keyId`.** Load that single record. If there is none, the server still computes and compares a dummy hash, so an unknown `keyId` takes about as long as a known one, and then fails.
3. **Recompute the hash** of the presented secret with the server pepper.
4. **Constant-time compare** it with the stored `SecretHashHex` using `CryptographicOperations.FixedTimeEquals`. The `keyId` lookup is not the security boundary; this comparison is.
5. **Check status.** The record's `Status` must be `active` (case-insensitive).
6. **Take `orgId` from the record.** The authenticated organization is whatever the stored row says.

### orgId is never taken from the payload

Neither batch schema has an `orgId` field, and the server deserializes strictly (unknown fields are rejected), so a body that carries `orgId` is rejected with 400. Every stored aggregate, context-insights and status row is stamped with the `orgId` from the key record, and relay batches are stored and listed per org from the same source. A holder of a valid key for org A therefore cannot write data attributed to org B, or read org B's relay batches.

---

## 7. Responses and client behavior

| Condition | Status | Notes |
|---|---|---|
| Missing header, malformed token, unknown `keyId`, wrong secret, or non-`active` status | **401** | Always the same response: `WWW-Authenticate: Bearer error="invalid_token"` and body `{ "error": "invalid_token" }`. It never reveals which check failed. |
| Endpoint switched off | **503** | See section 2. |
| Body is not valid JSON, has an unknown field, or fails validation | **400** | Problem details. |
| Relay push larger than `AgentRelay:MaxBatchBytes` (default 5 MiB), or not JSON | **413** / **400** | Relay only. |
| Relay batch id unknown for the caller's org | **404** | Relay only. |

The server never returns 403 or 429.

How the extension reacts (`src/core/agent-observability-core/src/sync/`):

- **401 or 403:** treated as "key missing, invalid or revoked". The extension stops, does not retry, and the sync result tells the developer to update their organization API key.
- **400** (rejected) and **503** (disabled): stop, no retry.
- **5xx, network errors and 429:** retried a few times with exponential backoff and jitter. On 429 it honors `Retry-After`, in case a proxy in front of the dashboard sends one.
- After a failure that is not retried, the sync window is left unchanged, so the same window is sent again on the next run. That is safe because the server upserts each row by `rowKey` (latest wins).

---

## 8. Not implemented

The following are **not** done by the code. Do not rely on them.

- **Rate limiting.** Neither the app nor the infrastructure limits request rates.
- **Request size limits on `/api/ingest/*`** beyond the web server's default limit, and **no limit on the number of buckets or rows** in a batch. Only the relay push has its own size cap (5 MiB by default), and the relay list endpoint caps `limit` at `AgentRelay:MaxListLimit` (500 by default).
- **An `Idempotency-Key` header** or server-side batch deduplication. Idempotency comes only from per-row `rowKey` upserts.
- **Key expiry** (`expiresAt`) and **last-used tracking** (`lastUsedAt`).
- **Logging, throttling or alerting on failed authentication.**
- **A user interface or API for managing keys.** Keys are issued with a script and revoked by editing the table (section 9).
- **Per-user authorization on the dashboard pages** (see section 1).

---

## 9. Lifecycle

### Issuance

- Keys are issued by whoever runs the dashboard, with [`infra/scripts/New-IngestionApiKey.ps1`](../../infra/scripts/New-IngestionApiKey.ps1), not by the extension. The script uses your Azure CLI login and needs **Key Vault Secrets User** on the Key Vault (to read the pepper) and **Storage Table Data Contributor** on the storage account (to write the record).
- It generates `keyId` and `secret`, computes `SecretHashHex` with the pepper, writes the record (`OrgId` from `-OrgId`, optional `-Label`) and prints the plaintext token once.
- Hand the token to the developer through an approved secret-sharing channel. They paste it with **Agent Observability: Set Organization API Key**, which stores it in SecretStorage.

### Rotation

- Issue a **new** key for the same `orgId` while the old key is still active, then revoke the old one.
- While both keys are active, each developer replaces their stored key in their own time; there is no synchronized cutover. Replacing the key overwrites the SecretStorage entry.
- Rotation does not change `orgId`, so earlier data stays attributed correctly.
- The server does not record when a key was last used, so it cannot tell you when everyone has switched. Agree a cutover date instead.

### Revocation

- Set the record's `Status` to `revoked` (or delete the row). It takes effect on the next request: the check fails at step 5 (or step 2) and the API returns **401**.
- Revocation is per `keyId`, so other keys for the same org keep working.
- On 401 the extension stops syncing. Nothing is lost: the unsent window is sent once a valid key is stored.

---

## 10. Summary

- Dashboard pages: Entra ID sign-in through Container Apps built-in authentication, only when `dashboardAuthClientId` is set. Without it the pages are public to anyone with the URL.
- `/api/ingest/*` and `/agent-otlp/*`: org API key in `Authorization: Bearer`, HTTPS only.
- Token `aoa_<keyId>_<secret>`, 256-bit random secret, plaintext shown once.
- Client keeps the key in VS Code SecretStorage only. The dashboard address is the user-scoped, https-only `agentObservability.sync.dashboardUrl` setting.
- Server stores only a peppered HMAC-SHA256 hash, looks up by `keyId`, compares in constant time, checks `Status`, and takes `orgId` from the record.
- Every authentication failure is the same 401.
- Not implemented: rate limiting, ingest size and batch-count limits, `Idempotency-Key`, key expiry, last-used tracking, auth-failure logging, key management UI.
