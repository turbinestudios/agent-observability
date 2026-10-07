# Pseudonymization Strategy: Developer Identity

Status: Implemented, with a per-install salt (see
[Implementation status](#implementation-status)). Code:
`src/core/agent-observability-core/src/aggregate/pseudonymizer.ts` (the id),
`src/core/agent-observability-core/src/secrets/pseudonymize.ts` (salt generation,
id pattern), and
`src/desktop/agent-observability-desktop/src/datahost/team/teamSalt.ts` (the
desktop's salt file and identity input).

## Problem

The local raw sources (GitHub Copilot's native SQLite telemetry database
`agent-traces.db`, and the agent CLIs' own session files) carry **no usable
developer identity** for a team view. As validated in
`tools/copilot-telemetry/copilot-telemetry-schema.json`, the Copilot database
contains **no developer email, no developer name, and no account identity** of any
kind. The `spans`, `span_attributes`, and `span_events` tables carry only
operational metadata (span timings, token counts, tool names, model names,
session/conversation IDs) plus raw content attributes that must never leave the
machine.

The desktop app's **team shard** still needs a member dimension: the Team view
counts members, shows each member's figures, and compares "me" with the team. The
desktop therefore **mints a pseudonymous developer id locally** and puts it on the
shard and on both batches embedded in it
([`schemas/team-shard.schema.json`](../../schemas/team-shard.schema.json)). The id
also names the shard file (`dev_<hex>.json`) in the team folder.

This document specifies how that id is minted.

## Design goals

1. **Stable** for a given member across sessions and across repositories, so
   distinct-member counts and per-member rollups are meaningful.
2. **Low collision** so two distinct members of a team do not map to the same id.
3. **Non-reversible to PII**: a reader of the team folder must not be able to recover
   an email, OS username, or machine name from the id.
4. **Not cross-correlatable**: the id must not be a global fingerprint that lets a
   third party link the same person across unrelated teams or datasets.
5. **No raw identity input ever leaves the machine.** Only the derived id does.

## Identity inputs available locally

The desktop app runs on the developer's machine and reads the following candidate
inputs. None of these come from `agent-traces.db`; they are ambient host signals.

| Input | Source | Stability | Collision risk | PII sensitivity |
|---|---|---|---|---|
| Git `user.email` | `git config --get user.email` (effective config) | High: set once per machine/global, rarely changes | Very low: globally unique by construction | High (is PII; must be hashed, never sent) |
| OS username | `os.userInfo().username` | Medium: stable per OS account, but resets on reinstall and differs per machine | Medium: "admin", "dev", "user" collide across machines | Medium |

### Why git `user.email` is the primary input

- **Stability across sessions and repositories.** Git identity is typically configured
  once in the global (`--global`) config and is identical in every repository on the
  machine. It survives app restarts and upgrades.
- **Low collision.** An email address is unique by construction, so two members will
  not collide.

The OS username is a **fallback input** only, used when git email is absent (see Edge
cases). If neither is available, the fixed literal `unknown-machine` is hashed; the
per-install salt still makes the resulting id unique to that install.

### Recommendation

> **Primary identity input: the effective git `user.email`, lowercased and trimmed.**
> Fallbacks (in order): git `user.email` absent → OS username; OS username absent →
> the literal `unknown-machine`. The chosen tier is computed **locally** only; it is
> **never placed in a shard or batch** (see "Identity tier" below).

## Hashing approach

The developer id is an **HMAC-SHA256** of the normalized identity input, keyed by a
secret salt, then truncated and prefixed.

```
normalizedInput = trim(lowercase(identityInput))         // e.g. "ada@contoso.com"
mac             = HMAC_SHA256(key = salt, message = utf8(normalizedInput))
devId           = "dev_" + lowercaseHex(mac[0 .. 16])    // first 16 bytes -> 32 hex chars
```

- **Algorithm:** HMAC-SHA256 (a keyed MAC, not a bare hash). A keyed construction is
  required: a bare `SHA256(email)` is trivially reversible for any known team because
  the input space (a list of colleague emails) is small and enumerable. The salt is
  the HMAC key and makes precomputation/dictionary attacks infeasible without it.
- **Normalization:** lowercase + trim so that `Ada@Contoso.com ` and `ada@contoso.com`
  produce the same id. (Git emails are case-insensitive in practice for this purpose.)
- **Encoding:** lowercase hexadecimal.
- **Truncation:** take the **first 16 bytes (128 bits)** of the MAC, yielding a
  **32-character** hex string. 128 bits keeps collision probability negligible at
  realistic team sizes (birthday-bound collision risk stays below 1e-12 for tens of
  thousands of members) while keeping the id compact enough for a file name and for
  display.
- **Prefix:** `dev_` so the value is self-describing in shards, file names, and logs.

Example output: `dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3`

### Salt: per-install vs shared

The salt is the security-critical parameter. Two options were considered:

**Option A: per-INSTALL random salt (implemented).** Generate 32 random bytes on
first use and keep them on that machine only. The same developer is consistent
**within that single install** but produces a *different* id on every reinstall and
on every machine, because each install has its own salt.

- Pro: strongest unlinkability; no shared secret to distribute or protect.
- Con: one person with a laptop and a desktop appears as two members, and a
  reinstall (or a deleted salt file) creates a third. Per-member rollups fragment
  across installs.

**Option B: shared salt (not implemented).** A single secret salt distributed to
every member of a team, so the same git email produces the **same** id on every
machine.

- Pro: cross-machine and cross-reinstall dedup would work.
- Con: the salt becomes a shared secret. Anyone holding it **plus** a candidate
  list of colleague emails can confirm-by-recompute which id maps to which person.
- Con: needs a distribution path. The desktop has none, and no setting accepts a
  salt.

### Implementation status

The hashing, normalization, fallback order and output format are implemented in
`aggregate/pseudonymizer.ts` and used by the desktop's team export:

- The desktop keeps its salt in its **own file**,
  `~/.agent-observability/desktop/team-salt` (owner-only permissions where the OS
  honours them), never in `config.json` and never in a shard or the team folder. If
  the file is absent or unreadable, a new random 32-byte salt is generated and
  written (`getOrCreateTeamSalt` in `datahost/team/teamSalt.ts`).
- The identity input is resolved by `getIdentityInput()` with no workspace and no
  machine id, so git's effective `user.email` (as `git config` resolves it from the
  app's working directory, normally the global one) is used, then the OS username,
  then the
  `unknown-machine` literal (`getTeamDeveloperId` in `datahost/team/teamSalt.ts`).
- Every install therefore uses its own random salt (Option A): the same developer
  gets a different id on each machine or reinstall, and the Team view can count one
  person more than once. Ids are still not reversible and not correlatable across
  teams.
- The identity tier (below) is computed alongside the id but is not stored or shown.

## Output format

| Property | Value |
|---|---|
| Function | `HMAC-SHA256(key = salt, message = utf8(normalize(identityInput)))` |
| Normalization | `trim` then `toLowerCase` |
| Encoding | lowercase hex |
| Length | first 16 bytes of the MAC → 32 hex characters |
| Prefix | `dev_` |
| Full length | 36 characters (`dev_` + 32 hex) |
| Example | `dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3` |

This single string is the only identity-derived value placed in a team shard. It
appears on the shard envelope, on the embedded **aggregate batch**
([`schemas/aggregate-batch.schema.json`](../../schemas/aggregate-batch.schema.json))
and on the embedded **context-insights batch**
([`schemas/context-insights-batch.schema.json`](../../schemas/context-insights-batch.schema.json)),
and it names the shard file. The context-insights batch conveys
repository-relative **customization-file paths** (instructions/skills/prompts/
agents/hooks) with counts only, so teams can review context-engineering hotspots; it
reuses this id derivation unchanged and ships no other identity input.

### Identity tier marker (LOCAL-ONLY diagnostic, NOT shipped in v1)

Because the input may fall back from email to username to the fixed literal, the
code records which input was used as a **tier** marker (`email` | `os_user` |
`machine`).

> **The tier marker is a LOCAL-ONLY diagnostic and MUST NOT appear in a team shard or
> either batch.** There is **no `tier` (or equivalent) field in any of the three
> schemas**, and each sets `additionalProperties: false` at every object level, so a
> shard carrying a tier marker would fail validation: the producer refuses to write
> it and every importer skips it. If a future schema version wants to surface id
> confidence, it must add an explicit field and bump `schemaVersion` first.

The tier is a category label, not an identity value, and reveals nothing about the
developer, but it is still excluded from shards per the rule above.

## Guarantees

- **Not reversible without the salt.** The team folder holds only `dev_<hex>`.
  Recovering the underlying email or username requires brute-forcing HMAC-SHA256
  keyed by a secret that never leaves the member's machine. Without the salt this is
  infeasible even with a known candidate list.
- **Salt never leaves the machine.** It lives only in the desktop's salt file and is
  used solely as the HMAC key. No shard field, file name, log line, or telemetry
  carries it. Privacy tests must assert the salt, all raw identity inputs, **and the
  local-only tier marker** are absent from every shard.
- **Same developer ⇒ same id within one install.** Deterministic HMAC + the install's
  salt + normalized input means one developer maps to one stable id across sessions
  and repositories on that install.
- **Not correlatable across teams or installs.** Because each install has its own
  random salt, the id cannot be used as a global fingerprint.
- **Explicitly NOT a security boundary against someone holding the salt.** Anyone
  with access to a member's salt file **and** an enumerable list of candidate emails
  can recompute `dev_<hex>` for each candidate and match it back to that member. The
  salt file is kept out of `config.json`, shards and the team folder for exactly this
  reason. Do not market the developer id as anonymization against someone with
  access to the member's machine.

## Edge cases

- **Missing git email.** If `git config --get user.email` returns empty (git not
  installed, or identity never configured), fall back to OS username; if that is also
  unavailable, fall back to the `unknown-machine` literal. The tier records which was
  used.

- **Machine reinstall / deleted salt file.** A new salt is generated, so the member
  gets a **new** id and a new shard file. The old shard stays in the team folder
  until someone removes it; the importer treats it as a separate member.

- **Multiple machines.** Each install has its own salt, so a developer who shares
  from two machines appears as **two** members.

- **Shared / role accounts.** If several people genuinely share one install, they
  share one developer id. This is a property of the input, not a bug.

- **Email changes (rename, domain migration).** Changing the configured git email
  produces a new id on the same install, splitting history at the change point.
  Treat as rare; no automatic re-linking is attempted.

## Reference algorithm (pseudocode)

```ts
function mintDeveloperId(salt: Buffer): { id: string; tier: string } {
  const { value, tier } = resolveIdentityInput(); // email -> os_user -> machine
  const normalized = value.trim().toLowerCase();
  const mac = hmacSha256(salt, Buffer.from(normalized, "utf8")); // 32 bytes
  const id = "dev_" + mac.subarray(0, 16).toString("hex");       // 32 hex chars
  return { id, tier };
}
```

`salt` is read from the desktop's salt file; `resolveIdentityInput()` reads git
config and the OS username locally and never emits the raw value.

## Summary

Implemented algorithm:

```
identityInput = effective git user.email   (fallback: OS username -> "unknown-machine")
normalized    = trim(lowercase(identityInput))
salt          = per-INSTALL random salt (32 bytes) in ~/.agent-observability/desktop/team-salt; never transmitted
mac           = HMAC-SHA256(key = salt, message = utf8(normalized))
developerId   = "dev_" + lowercaseHex(mac[0:16])    // first 16 bytes => 32 hex chars, e.g. dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3
```

Rationale: git `user.email` is the most stable, lowest-collision identity input
available locally. HMAC-SHA256 keyed by a per-install salt makes the id deterministic
and stable for a member on that install while remaining non-reversible to PII for
anyone reading the team folder and non-correlatable across teams. The salt stays in
its own file and never leaves the machine. The cost is that one person sharing from
several installs appears as several members.
