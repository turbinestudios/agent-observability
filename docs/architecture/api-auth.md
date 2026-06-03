# Organization API Key Lifecycle (Extension → Dashboard Ingestion API)

Status: Design (Phase 0 contract — see `docs/plans/planned/agent-observability-vscode-extension-refactor.md`, Phase 4 and Phase 6).

## Purpose

The VS Code extension pushes **opt-in, aggregated, non-sensitive** statistics to the dashboard ingestion API. This document specifies how the extension authenticates those uploads using an **organization API key**, and how that key is issued, stored, transported, validated, rotated, and revoked.

Scope note: This auth scheme protects the *ingestion* endpoints only (e.g. `POST /api/v1/aggregates`, `POST /api/v1/sync-status`). The interactive dashboard web UI continues to use its existing user/Entra authentication and is out of scope here.

### Non-goals / privacy boundary

This document does not change what is sent. Raw content that must never leave the developer machine (`copilot_chat.user_request`, `gen_ai.input.messages`, `gen_ai.output.messages`, `gen_ai.system_instructions`, `gen_ai.tool.call.arguments`, `gen_ai.tool.call.result`, `gen_ai.tool.definitions`/`description`, `copilot_chat.reasoning_content`, `copilot_chat.hook_input`/`hook_output`/`hook_command`, `copilot_chat.request.options`, plus file paths, commit hashes, machine name, OS username, and developer email) is excluded by the aggregate engine, regardless of authentication. The full authoritative forbidden-fields list lives in `aggregate-payload-schema-v1.md` §7. The API key controls *who may submit aggregates for an org*, not *what* an aggregate may contain.

---

## 1. Key Format

The API key is an **opaque, high-entropy bearer token**. It carries no payload and is not a JWT — it is a random secret that the server maps to an organization.

Recommended structure:

```
aoa_<keyId>_<secret>
```

| Segment   | Example                              | Purpose                                                                 |
|-----------|--------------------------------------|-------------------------------------------------------------------------|
| `aoa_`    | `aoa_`                               | Fixed prefix. Identifiable and **greppable** so keys are easy to detect in logs, secret scanners, and accidental commits. |
| `<keyId>` | `7f3a9c2e` (8–12 base32 chars)       | Public, non-secret lookup handle. Indexes the stored hash row; lets the server find the candidate record without scanning every key. |
| `<secret>`| `qx4k...` (≥ 32 bytes of entropy)    | The actual secret. Base32 (Crockford) or base62 encoded, no padding, URL/header safe. |

Rules:

- **Entropy:** the `<secret>` segment MUST contain at least 32 bytes (256 bits) from a CSPRNG. base32 of 32 bytes ≈ 52 chars; base62 ≈ 43 chars.
- **Encoding:** use an alphabet that is safe to place verbatim in an HTTP header and easy to copy (base32 Crockford avoids ambiguous `0/O`, `1/l`; base62 is more compact). Pick one and keep it consistent.
- **Prefix is a feature, not a secret:** the `aoa_` prefix enables push-protection rules (GitHub secret scanning, gitleaks, internal log scrubbers) and makes incident triage trivial.
- **Opaqueness:** clients MUST treat the whole string as opaque. The `keyId`/`secret` split is a server convention; clients send the entire token unchanged.

The full plaintext key is shown to the org admin **exactly once** at issuance. The platform never displays it again.

---

## 2. Storage

### Extension side (client)

- The key is stored **only** in VS Code **SecretStorage** (`vscode.SecretStorage`, backed by the OS keychain / Credential Manager / libsecret).
- It MUST NOT be written to `settings.json`, workspace settings, `.env`, task definitions, or any file that can be committed to source control.
- It MUST NOT be logged, echoed into the output channel, or included in sync diagnostics. Diagnostics may show only the non-secret `keyId` (e.g. `aoa_7f3a9c2e_…masked`).
- Sync is blocked when consent is off **or** no key is present (Phase 4 exit criteria).

### API side (server)

- The server **never stores the plaintext key**. It stores only a **salted hash** of the secret.
- Recommended record shape (Azure Table Storage, consistent with the aggregate store):

  | Field            | Notes                                                                 |
  |------------------|-----------------------------------------------------------------------|
  | `PartitionKey`   | `apikey`                                                              |
  | `RowKey`         | `keyId` (the public lookup handle from the token)                     |
  | `orgId`          | Organization this key authenticates as. **Derived here, never trusted from the request body.** |
  | `secretHash`     | Hash of the secret segment (see below)                                |
  | `salt`           | Per-key random salt (if using a salted general-purpose KDF)           |
  | `algo`           | Hash/KDF identifier + parameters, for future migration                |
  | `status`         | `active` \| `revoked`                                                 |
  | `createdAt`      | Issuance timestamp                                                    |
  | `expiresAt`      | Optional hard expiry                                                  |
  | `lastUsedAt`     | Updated opportunistically for observability (best-effort, not on hot path) |
  | `label`          | Human description (e.g. "Team Platform — prod")                       |

- **Hashing choice:** because the secret already has ≥ 256 bits of entropy (unlike a human password), a fast keyed hash is acceptable and avoids per-request KDF cost:
  - Preferred: **HMAC-SHA-256** with a server-side pepper held in Key Vault. The pepper is not in the database, so a DB-only leak does not allow offline brute force.
    - **As implemented (Phase 6):** `secretHash = HMAC-SHA256(pepper, secret)` — the secret segment alone is the HMAC message. Because the secret carries ≥ 256 bits of CSPRNG entropy and `keyId` already uniquely indexes the record, binding `keyId` into the message adds no practical collision resistance, so the implementation uses the secret-only construction. A future provisioning tool MUST use the same construction or stored hashes will not validate.
  - Alternatively a memory-hard KDF (Argon2id / scrypt) with a per-key `salt`. This is heavier than necessary for high-entropy tokens but is fine if a single hashing primitive is already standardized in the platform.
  - In all cases: store `algo` so the scheme can be rotated later without a flag-day migration.

---

## 3. Transport

- **HTTPS only.** Plain HTTP requests are rejected (and ideally never reach the app — terminate TLS at the gateway and redirect/deny `http://`). HSTS is set on the ingestion host.
- The key is sent in the standard **`Authorization: Bearer <key>`** header:

  ```
  POST /api/v1/aggregates HTTP/1.1
  Host: dashboard.example.com
  Authorization: Bearer aoa_7f3a9c2e_qx4k...
  Content-Type: application/json
  Idempotency-Key: 0d6b2f1a-...   # see §6
  ```

- The key MUST NOT be placed in the URL/query string (URLs are logged by proxies, gateways, and browser history) or in a cookie (no browser context; avoids CSRF surface).

### Why `Authorization: Bearer` instead of a custom header

- **Standard semantics.** RFC 6750 Bearer is the well-understood "possession of this token authorizes the request" model, which is exactly our case. Tooling, SDKs, and gateways already special-case `Authorization`.
- **Built-in hygiene.** Reverse proxies, API gateways, and logging frameworks redact `Authorization` by default; custom headers like `X-Api-Key` are frequently logged in plaintext unless every layer is configured to scrub them.
- **No new contract.** A custom header would require us to document and defend a bespoke scheme for no functional gain.
- A custom header (`X-Aoa-Api-Key`) is acceptable only as a fallback if an intermediary strips `Authorization`; if added, it follows the identical validation path and must be scrubbed from logs. Default is Bearer.

---

## 4. Server Validation

On each ingestion request:

1. **Extract & parse.** Read the `Authorization` header; require the `Bearer ` scheme and the `aoa_` prefix. Reject malformed tokens early.
2. **Look up by `keyId`.** Split out the public `keyId` and load that single record. If no record exists → unauthenticated (see §5).
3. **Recompute the hash** of the presented secret using the stored `algo`/`salt` (and server pepper).
4. **Constant-time compare** the recomputed hash against the stored `secretHash` using a fixed-time equality function (e.g. `CryptographicOperations.FixedTimeEquals` in .NET). Never use ordinary `==`/`string.Equals` on the hash — timing differences can leak. The `keyId` lookup is *not* the security boundary; the secret comparison is.
5. **Check status/expiry.** `status == active` and (if set) `now < expiresAt`. Otherwise → revoked/expired handling (see §5).
6. **Resolve `orgId` from the record.** The authenticated organization is whatever the stored row says — it is **implied by the key**.

### orgId is never taken from the payload

The aggregate batch body MUST NOT contain an `orgId` that the server trusts. If a client includes one, the server either ignores it or rejects the request on mismatch. **The authoritative `orgId` always comes from the validated key record.** This prevents a holder of a valid Team-A key from writing aggregates attributed to Team-B by spoofing the body. All persisted aggregate rows are stamped with the key-derived `orgId`.

---

## 5. Error Semantics (401 vs 403)

The distinction follows HTTP semantics: **401 = "I don't know who you are"**, **403 = "I know who you are, but you may not do this."**

| Condition                                                        | Status | `WWW-Authenticate` | Notes |
|------------------------------------------------------------------|--------|--------------------|-------|
| Missing `Authorization` header                                   | **401**| `Bearer`           | No credential presented. |
| Malformed token (bad scheme, bad prefix, unparseable)            | **401**| `Bearer error="invalid_token"` | Treated as no valid credential. |
| `keyId` not found / secret hash mismatch                         | **401**| `Bearer error="invalid_token"` | Do **not** reveal which half was wrong. |
| Key expired                                                      | **401**| `Bearer error="invalid_token"` | Authentication can no longer be established. |
| Key **revoked**                                                  | **401**| `Bearer error="invalid_token"` | A revoked key is no longer a valid identity. Return 401 so the extension surfaces "re-authenticate / replace key", not "permission problem". |
| Valid key, but action not allowed for that org (e.g. org disabled, wrong endpoint scope) | **403**| —                  | Identity is established; authorization fails. |
| Request over plain HTTP                                          | rejected | —                | Blocked at gateway before app logic where possible. |

Implementation guidance:

- Responses for all 401 cases SHOULD be **indistinguishable** beyond the optional `error=` hint — never confirm that a `keyId` exists. Avoid different latencies between "unknown keyId" and "known keyId, wrong secret" (the constant-time compare plus a uniform lookup path helps here).
- Error bodies are minimal and machine-readable, e.g. `{ "error": "invalid_token" }`. No stack traces, no echo of the submitted key.
- The extension maps 401 → "API key missing/invalid/revoked — open key setup", and 403 → "key valid but sharing not permitted for this org — contact admin." Neither is retried automatically (see §6).

---

## 6. Rate Limiting, Abuse, and Idempotency Interplay

### Rate limiting / abuse

- Apply per-`orgId` (and optionally per-`keyId`) rate limits at the gateway: a sustained requests/min ceiling plus a burst allowance. Ingestion is periodic batch sync, so limits can be modest.
- On limit exceeded, return **429 Too Many Requests** with a `Retry-After` header. The extension's background sync honors `Retry-After` and applies exponential backoff with jitter (Phase 7 retry/backoff).
- **Cap request body size** (reject oversized batches with 413) and bound batch item counts — defends against accidental or malicious flooding independent of auth.
- Repeated 401s from a single source/`keyId` are throttled and alerted; this both slows credential-guessing and surfaces a misconfigured or compromised extension. A leaked-key signal (e.g. secret-scanner hit on the `aoa_` prefix) should trigger proactive revocation.
- All auth failures are logged with `keyId` (never the secret) and source metadata for abuse investigation.

### Idempotency interplay

- Aggregate batches carry an idempotency key (`Idempotency-Key` header or batch ID from Phase 5). The server deduplicates writes so a retried batch is applied **at most once**.
- **Auth runs before idempotency.** A request is authenticated and authorized first; only an accepted request's idempotency key is recorded.
- The **idempotency dedup scope is the key-derived `orgId`**, not anything in the body. The same batch ID submitted under two different org keys is two distinct logical writes; a replay under the *same* org returns the original result without double-writing.
- This composition makes the safe client behavior simple: on 429/5xx/network failure, **retry the same batch with the same idempotency key**; on 401/403, **stop and prompt the user** (a retry will not succeed and only burns rate budget).

---

## 7. Lifecycle

### Issuance

- **Out of scope of the extension.** Keys are generated by the **platform team / org admin** via an internal admin tool or platform CLI, not by the VS Code client.
- Generation: `keyId = random base32`, `secret = CSPRNG ≥ 32 bytes`, assemble `aoa_<keyId>_<secret>`. The server stores only `keyId` + `secretHash` (+ salt/algo/pepper-derived) and the `orgId` mapping. Plaintext is shown to the admin once and never persisted.
- The admin distributes the key to developers through an approved secret-sharing channel; developers paste it into the extension's key-setup UI, which writes it to SecretStorage.

### Rotation

- Rotation = issue a **new** key for the same `orgId` while the old key is still valid, then retire the old one.
- **Overlap window:** both the old and new keys are `active` simultaneously for a defined period (e.g. 7–30 days). This lets every developer's extension swap to the new key with **zero downtime** — no synchronized cutover required.
- Extension support: the key-setup/rotation UI lets a developer **replace** the stored key. Replacement overwrites the SecretStorage entry atomically; in-flight syncs finish on whichever key they started with. No code change is needed because `orgId` is resolved server-side per key.
- After the overlap window closes, the old key is **revoked** (see below). Telemetry on `lastUsedAt` per `keyId` lets the platform confirm migration is complete before revoking.
- Rotation does not change `orgId`, so historical aggregates remain correctly attributed across the rotation.

### Revocation

- An admin sets the key record `status = revoked` (immediate) — used for the retired half of a rotation, a suspected leak, or offboarding.
- Effect is immediate on the next request: validation fails at §4 step 5 and the API returns **401** (see §5). No grace period for the revoked key itself.
- Revocation is per-`keyId`, so revoking one key never affects other active keys for the same org.
- The extension, on receiving 401, stops syncing and prompts the developer to enter the replacement key; queued aggregate batches remain local and are sent (idempotently) once a valid key is stored.

### Expiry (optional)

- Keys MAY carry an `expiresAt`. Expiry behaves like revocation (→ 401) but is automatic. If used, the platform should schedule rotation comfortably before expiry to preserve the overlap window.

---

## 8. Summary Checklist (for implementers)

- [ ] Token format `aoa_<keyId>_<secret>`, secret ≥ 32 bytes CSPRNG, header/URL-safe encoding.
- [ ] Client stores key in VS Code SecretStorage only; never settings/files/logs.
- [ ] Server stores salted/peppered **hash** keyed by `keyId`; never plaintext.
- [ ] HTTPS only; `Authorization: Bearer <key>`; key never in URL/query/cookie.
- [ ] Lookup by `keyId`, **constant-time** secret hash compare, status/expiry check.
- [ ] `orgId` resolved from the key record; never trusted from the request body.
- [ ] 401 for missing/malformed/invalid/expired/revoked; 403 for authenticated-but-not-permitted.
- [ ] 429 + `Retry-After` for rate limits; body-size and batch-count caps.
- [ ] Idempotency dedup scoped to key-derived `orgId`; auth precedes idempotency; retry same key on 429/5xx, stop on 401/403.
- [ ] Issuance by platform/admin (not the extension); rotation with overlap window; immediate per-key revocation.
