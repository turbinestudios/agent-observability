# Pseudonymization Strategy: Developer Identity

Status: Proposed (Phase 0 contract)
Owner: Aggregation and Privacy workstream
Related: `docs/plans/planned/agent-observability-vscode-extension-refactor.md` (Phases 0, 4, 5)

## Problem

The local raw source is GitHub Copilot's native SQLite telemetry database
(`agent-traces.db`). As validated in
`tools/copilot-telemetry/copilot-telemetry-schema.json`, this database contains
**no developer email, no developer name, and no account identity** of any kind.
The `spans`, `span_attributes`, and `span_events` tables carry only operational
metadata (span timings, token counts, tool names, model names, session/conversation
IDs) plus raw content attributes that must never leave the machine.

By contrast, the cloud product the aggregate store must eventually replace
(`Services/LogAnalyticsService.cs`) derives a developer dimension from
`Properties["user.email"]` falling back to `UserId`:

```kusto
| extend Developer=coalesce(tostring(Properties["user.email"]), tostring(UserId), "unknown")
```

That `user.email` came from the OTEL collector's enrichment context, **not** from
Copilot telemetry. Once the collector path is retired (Phase 11), the only way to
populate a developer dimension for org-level pages
(`DeveloperActivitySummary.Developer`, `DashboardMetrics.ActiveDevelopers`) is for
the VS Code extension to **mint a pseudonymous developer id locally** and attach it
to outgoing aggregate batches.

This document specifies how that id is minted.

## Design goals

1. **Stable** for a given developer across sessions and across repositories, so
   `ActiveDevelopers` counts (`dcount`) and per-developer rollups are meaningful.
2. **Low collision** so two distinct developers in an org do not map to the same id.
3. **Non-reversible to PII**: the cloud must not be able to recover an email, OS
   username, or machine name from the id.
4. **Org-consistent**: the same physical developer should resolve to the same id
   across all their installs within one organization, enabling org-level dedup.
5. **Not cross-correlatable** outside the organization: the id must not be a global,
   org-independent fingerprint that lets a third party link the same person across
   unrelated orgs or datasets.
6. **No raw identity input ever leaves the machine** — only the derived id does.

## Identity inputs available locally

The extension runs inside VS Code on the developer's machine and can read the
following candidate inputs. None of these come from `agent-traces.db`; they are
ambient host/VS Code signals.

| Input | Source API | Stability | Collision risk | PII sensitivity |
|---|---|---|---|---|
| Git `user.email` | `git config --get user.email` (effective config) | High — set once per machine/global, rarely changes | Very low — globally unique by construction | High (is PII; must be hashed, never sent) |
| Git `user.name` | `git config --get user.name` | Medium — display name, may be non-unique | Medium — common names collide | Medium |
| OS username | `os.userInfo().username` / `$env:USERNAME` / `$USER` | Medium — stable per OS account, but resets on reinstall and differs per machine | Medium — "admin", "dev", "user" collide across machines | Medium |
| VS Code `machineId` | `vscode.env.machineId` | High per machine — but **per machine, not per developer** | Low | Low (opaque) but identifies a device, not a person |

### Why git `user.email` is the primary input

- **Stability across sessions and repositories.** Git identity is typically configured
  once in the global (`--global`) config and is identical in every repository on the
  machine. It survives VS Code restarts, workspace switches, and extension upgrades.
- **Low collision.** An email address is unique by construction within an organization,
  so two developers will not collide.
- **Org consistency across machines.** A developer who works from a laptop and a
  desktop usually configures the same git email on both. With an org-shared salt
  (see below) this yields the **same** developer id from both machines — which is
  exactly the cross-machine dedup behavior `ActiveDevelopers` needs. `machineId`
  cannot do this because it is per device; `os username` cannot reliably do this
  because accounts differ per machine.

`machineId` and OS username are retained only as **fallback inputs** when git email
is absent (see Edge cases). They are deliberately *not* mixed into the primary input,
because mixing a per-machine value (`machineId`) into the hash would make the same
developer produce different ids on different machines, breaking goal 4.

### Recommendation

> **Primary identity input: the effective git `user.email`, lowercased and trimmed.**
> Fallbacks (in order): git `user.email` absent → OS username; OS username absent →
> VS Code `machineId`. The chosen tier is recorded **locally** so the id can be
> interpreted correctly; it is **never sent in an aggregate batch** (see "Identity
> tier" below).

## Hashing approach

The developer id is an **HMAC-SHA256** of the normalized identity input, keyed by a
secret salt, then truncated and prefixed.

```
normalizedInput = trim(lowercase(identityInput))         // e.g. "ada@contoso.com"
mac             = HMAC_SHA256(key = salt, message = utf8(normalizedInput))
devId           = "dev_" + lowercaseHex(mac[0 .. 16])    // first 16 bytes -> 32 hex chars
```

- **Algorithm:** HMAC-SHA256 (a keyed MAC, not a bare hash). A keyed construction is
  required: a bare `SHA256(email)` is trivially reversible for any known org because
  the input space (a list of employee emails) is small and enumerable. The salt is
  the HMAC key and makes precomputation/dictionary attacks infeasible without it.
- **Normalization:** lowercase + trim so that `Ada@Contoso.com ` and `ada@contoso.com`
  produce the same id. (Git emails are case-insensitive in practice for this purpose.)
- **Encoding:** lowercase hexadecimal.
- **Truncation:** take the **first 16 bytes (128 bits)** of the MAC, yielding a
  **32-character** hex string. 128 bits keeps collision probability negligible at
  realistic org sizes (birthday-bound collision risk stays below 1e-12 for tens of
  thousands of developers) while keeping the id compact for storage as an Azure Table
  Storage key and for display.
- **Prefix:** `dev_` so the value is self-describing in payloads, logs, and the
  `Developer` column that replaces `LogAnalyticsService`'s `coalesce(...user.email...)`.

Example output: `dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3`

### Salt: per-install vs org-shared

The salt is the security-critical parameter. Two options:

**Option A — per-INSTALL random salt.** Generate 32 random bytes on first run, store
in VS Code `SecretStorage`. The same developer is consistent **within that single
install** but produces a *different* id on every reinstall and on every machine,
because each install has its own salt. Cloud-side dedup across machines is impossible.

- Pro: strongest unlinkability; no shared secret to distribute or protect.
- Con: breaks goal 4 (org-level dedup). `ActiveDevelopers` would overcount —
  one person with a laptop + desktop counts as two, and a reinstall creates a third.
  Per-developer rollups fragment. This defeats the purpose of having a developer
  dimension at all.

**Option B — ORG-shared salt.** A single secret salt is provisioned per organization
(alongside the organization API key already planned in Phase 4) and stored in VS Code
`SecretStorage`. Every install in the org keys HMAC with the **same** salt, so the
same git email deterministically produces the **same** id everywhere in the org.

- Pro: satisfies goal 4 — cross-machine and cross-reinstall dedup works; `dcount`
  of developer id is a true headcount; per-developer rollups are stable.
- Pro: still satisfies goals 3 and 5 — the id is not reversible without the salt, and
  because the salt is org-scoped the id is *not* a global fingerprint usable to
  correlate the same person across unrelated orgs.
- Con: the salt is a shared secret. Anyone holding the org salt **plus** a candidate
  list of employee emails can confirm-by-recompute which id maps to which person.
  This is an accepted, bounded risk (see Guarantees).

### Recommendation

> **Use Option B: an organization-shared salt.** It is the only option that delivers
> org-level pseudonymity that is *stable for a developer within the org* while keeping
> the id non-reversible to PII for the cloud service and non-correlatable across orgs.
> The salt is provisioned with the org API key during Phase 4 setup and stored in VS
> Code `SecretStorage`. It is used purely as the HMAC key and is **never transmitted**
> in any aggregate batch.

Provisioning detail: the org salt is delivered to the extension out of band (e.g.,
together with the org API key at onboarding) and written to `SecretStorage`. It is
high-entropy (>= 32 random bytes), opaque, and rotatable. Rotating the salt
re-pseudonymizes the whole org (all developers get new ids) — acceptable as a rare,
deliberate operation, not part of normal flow.

## Output format

| Property | Value |
|---|---|
| Function | `HMAC-SHA256(key = orgSalt, message = utf8(normalize(identityInput)))` |
| Normalization | `trim` then `toLowerCase` |
| Encoding | lowercase hex |
| Length | first 16 bytes of the MAC → 32 hex characters |
| Prefix | `dev_` |
| Full length | 36 characters (`dev_` + 32 hex) |
| Example | `dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3` |

This single string is the only identity-derived value placed in outgoing batches.
It maps onto the `Developer` dimension currently produced by
`LogAnalyticsService.GetDeveloperActivityAsync` and the `ActiveDevelopers` count in
`DashboardMetrics`. The same pseudonymous id (and nothing more identity-derived) is
also carried by the additive **context-insights batch**
(`schemas/context-insights-batch.schema.json`), which conveys repository-relative
**customization-file paths** (instructions/skills/prompts/agents/hooks) with counts
only so teams can review context-engineering hotspots; it reuses this id derivation
unchanged and ships no other identity input.

### Identity tier marker (LOCAL-ONLY diagnostic — NOT shipped in v1)

Because the input may fall back from email to username to machineId, the extension
records which input was used as a **tier** marker (`email` | `os_user` | `machine`).

> **The tier marker is a LOCAL-ONLY diagnostic and MUST NOT appear in v1 aggregate
> batches.** There is **no `tier` (or equivalent) field in the v1 aggregate batch
> schema** (`schemas/aggregate-batch.schema.json`), and that schema sets
> `additionalProperties: false` at every object level — so attaching a tier marker
> to a batch would cause the **entire batch to be rejected** by the ingestion API.
> The tier is kept on the developer's machine only (e.g. for local diagnostics and
> to flag lower-confidence ids in local tooling); it never travels to the cloud. If
> a future schema version wants to surface id confidence server-side, it must add an
> explicit field and bump `schemaVersion` first.

The tier is a category label, not an identity value, and reveals nothing about the
developer — but it is still excluded from outgoing batches per the rule above.

## Guarantees

- **Not reversible without the salt.** The cloud stores only `dev_<hex>`. Recovering
  the underlying email/username/machineId requires brute-forcing HMAC-SHA256 keyed by
  a secret the cloud never receives. Without the salt this is infeasible even with a
  known candidate list.
- **Salt never sent to cloud.** The org salt lives only in VS Code `SecretStorage` on
  developer machines and is used solely as the HMAC key. No payload field, log line,
  sync-health report, or telemetry carries it. Privacy tests (Phase 5/6) must assert
  the salt, all raw identity inputs, **and the local-only tier marker** are absent
  from every outgoing batch (the v1 schema has no `tier` field and would reject one).
- **Same developer ⇒ same id within the org.** Deterministic HMAC + org-shared salt +
  normalized input means one developer maps to one stable id across sessions,
  repositories, machines, and reinstalls within the org.
- **Not correlatable across organizations.** Because the salt is org-scoped, the same
  person produces *different* ids in different orgs; the id cannot be used as a global
  cross-org fingerprint.
- **Explicitly NOT a security boundary against a malicious org admin.** An adversary
  who already holds the org salt **and** an enumerable list of candidate emails can
  recompute `dev_<hex>` for each candidate and match it back to a person. The scheme
  protects against the **cloud service / data-at-rest** seeing PII and against
  cross-org correlation; it does **not** protect a developer's identity from an
  insider who legitimately controls the org's own salt and roster. This is by design:
  org-level dedup inherently requires the org to hold the linking key. Treat the org
  salt as confidential, but do not market the developer id as anonymization against
  the org itself.

## Edge cases

- **Missing git email.** If `git config --get user.email` returns empty (git not
  installed, or identity never configured), fall back to OS username; if that is also
  unavailable, fall back to VS Code `machineId`. Record the tier so the resulting id
  is flagged as lower-confidence. Note the tradeoff: an OS-username/machineId fallback
  will **not** cross-machine-dedup the way an email does, so a developer who lacks git
  email on one machine may appear as a separate id there. This is acceptable
  degradation and surfaces via the tier marker.

- **Machine reinstall / new OS account.** With the recommended email input and the
  org-shared salt, a reinstall yields the **same** id as long as the developer
  reconfigures the same git email — which is the normal case. (Under the rejected
  per-install salt option this would have produced a new id, fragmenting the
  developer's history.) If the fallback tier was in use (username/machineId), a
  reinstall *will* produce a new id; this is an inherent limitation of those inputs.

- **Multiple machines.** Same email + same org salt ⇒ **same id** across all the
  developer's machines, so they correctly count as one developer in `ActiveDevelopers`
  and aggregate into a single per-developer rollup. This is the primary reason email
  is preferred over `machineId` as the identity input.

- **Shared / role accounts.** If several people genuinely share one git email (e.g., a
  shared CI or kiosk identity), they will share one developer id. This is a property of
  the input, not a bug; document it so org dashboards interpret such ids as a shared
  identity rather than one person.

- **Email changes (rename, domain migration).** Changing the configured git email
  produces a new id, splitting history at the change point. Treat as rare; no
  automatic re-linking is attempted.

## Reference algorithm (pseudocode)

```ts
function mintDeveloperId(orgSalt: Buffer): { id: string; tier: string } {
  const { value, tier } = resolveIdentityInput(); // email -> os_user -> machine
  const normalized = value.trim().toLowerCase();
  const mac = hmacSha256(orgSalt, Buffer.from(normalized, "utf8")); // 32 bytes
  const id = "dev_" + mac.subarray(0, 16).toString("hex");          // 32 hex chars
  return { id, tier };
}
```

`orgSalt` is read from VS Code `SecretStorage`; `resolveIdentityInput()` reads git
config / OS / `vscode.env.machineId` locally and never emits the raw value.

## Summary

Recommended algorithm:

```
identityInput = effective git user.email   (fallback: OS username -> vscode.env.machineId)
normalized    = trim(lowercase(identityInput))
salt          = per-ORGANIZATION shared secret salt (>=32 random bytes) stored in VS Code SecretStorage; never transmitted
mac           = HMAC-SHA256(key = salt, message = utf8(normalized))
developerId   = "dev_" + lowercaseHex(mac[0:16])    // first 16 bytes => 32 hex chars, e.g. dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3
```

Rationale: git `user.email` is the most stable, lowest-collision identity input
available locally and is the same across a developer's machines, so it cross-machine
dedups correctly. HMAC-SHA256 with an **org-shared** salt makes the id deterministic
and stable for a developer within the org (enabling true `ActiveDevelopers` counts and
per-developer rollups) while remaining non-reversible to PII for the cloud and
non-correlatable across orgs. The salt stays in `SecretStorage` and never leaves the
machine. The scheme is explicitly not a defense against a malicious org admin who holds
the salt and an email roster.
