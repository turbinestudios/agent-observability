# Agent Observability (Local)

Privacy-first VS Code extension for observing your local GitHub Copilot agent
activity. Raw telemetry (prompts, completions, tool I/O, file paths) stays on
your machine. Only **opt-in, aggregated, non-sensitive** statistics are ever
shared with an organization dashboard.

## Features

| Capability | Status |
| --- | --- |
| Activity Bar container, three views, commands, settings | Shipped |
| Read-only local SQLite (`agent-traces.db`) ingestion (snapshot + read-only connection) | Shipped |
| Local session detail timeline + local workflow deviation detection | Shipped |
| Workflow predicate DSL (metadata + local-only content predicates) | Shipped |
| Consent toggle + organization API key in SecretStorage (opt-in, off by default) | Shipped |
| Aggregate engine (30-min time bins, pseudonymous developer id, idempotent batch/row ids) | Shipped |
| Upload to the dashboard ingestion API with retry/backoff | Shipped |

All raw content stays on the machine; only opt-in aggregate batches are uploaded.

## Views

- **Local Overview** — summary of local Copilot agent activity.
- **Sessions** — list and drill into local agent sessions (local-only detail).
- **Sync** — consent status and upload of opt-in aggregate batches.

## Commands

All under the **Agent Observability** category:

- `Agent Observability: Refresh`
- `Agent Observability: Sync Now`
- `Agent Observability: Open Settings`
- `Agent Observability: Set Organization API Key`
- `Agent Observability: Toggle Cloud Sharing`

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `agentObservability.dashboardUrl` | `""` | Cloud ingestion base URL (blank disables uploads). |
| `agentObservability.sync.enabled` | `false` | Opt in to cloud aggregate sharing (opt-out by default). |
| `agentObservability.sync.intervalMinutes` | `60` | Background sync interval (minimum 5). |
| `agentObservability.localTelemetry.enabled` | `true` | Feature flag for the local telemetry view. |
| `agentObservability.sqlitePath` | `""` | Override path to `agent-traces.db` (blank = auto-detect). |
| `agentObservability.deviation.maxSessionMinutes` | `60` | Local deviation detector: max expected session duration. |
| `agentObservability.workflows` | `[]` | Optional per-repository expected workflows for the local deviation detector. Evaluated on-machine; never uploaded. |

## Workflow predicate DSL

`agentObservability.workflows` lets you describe the agent workflows you expect
per repository so the **local** deviation detector can flag sequence, missing,
timeout, and failure-rate anomalies. There are two tiers of matching, and both
run entirely on your machine.

**Tier 1 — metadata predicates (safe).** A `StepPredicate` filters the safe
interaction metadata: `operation`, `agentName`, `agentMode`, `model`,
`toolName`, `success`. Every field is optional (absent = match any); strings
compare case-insensitively. Use them in `steps[].predicate` and in an optional
`triggerPredicate` that scopes *which* interactions belong to the workflow (the
local analog of the cloud dashboard's `TriggerKqlQuery`). The legacy
`expectedSequence` (an ordered list of agent names) still works and is the
degenerate case of `steps`.

**Tier 2 — content predicates (local-only).** A step may add a
`contentPredicate` that inspects a raw `span_attributes` value (e.g. the user
prompt or a tool's arguments) via `contains` (case-insensitive substring),
`matches` (regex), and `negate`. The `attribute` is restricted to the
forbidden-to-sync content keys (plus `copilot_chat.mode_name`); any other key is
rejected and the step is skipped. `matches` is held to a conservative,
ReDoS-safe regex subset: catastrophic-backtracking shapes — including any regex
alternation `|` under a repetition such as `(a|b)+` — are rejected (use a
character class like `[ab]+` instead), and regex matching runs only over the
first 1,000 characters of the value (vs 10,000 for `contains`) to bound
backtracking cost. Prefer `contains` for simple checks.

```jsonc
"agentObservability.workflows": [
  {
    "repository": "https://github.com/org/repo",
    "workflows": [
      {
        "name": "feature-development",
        "triggerPredicate": { "agentMode": "agent" },
        "steps": [
          { "name": "plan",   "predicate": { "agentName": "planner", "operation": "chat" } },
          { "name": "code",   "predicate": { "agentName": "coder", "toolName": "edit_file" } },
          {
            "name": "no-secrets-in-prompt",
            "predicate": { "operation": "chat" },
            "contentPredicate": { "attribute": "copilot_chat.user_request", "contains": "AKIA", "negate": true }
          }
        ],
        "maxDurationMinutes": 45
      }
    ]
  }
]
```

### Privacy contract for the DSL

The privacy boundary is what makes the two tiers different:

- **Metadata predicates** read only the safe `Interaction` projection — the same
  non-sensitive fields the cloud aggregate already permits.
- **Content predicates** read raw content through a scoped, **local-only**
  database path. The matched text is used to compute a boolean and is **never**
  copied into a deviation: a content-condition failure is described only as
  `step '<name>' content condition not met`, naming the step, never the value.
- Any deviation a content predicate contributes to is flagged
  `contentDerived` and rendered with a **Local only** badge in the session
  detail panel. These can **never** be synced — the cloud aggregate path
  (`getAggregationRows` → `buildBatch`) is a separate, content-free read, and
  the aggregate batch schema has no slot for a deviation. Deviations never cross
  the network at all today; the flag makes that boundary explicit and
  future-proof. See `docs/privacy-validation.md` and `aggregate/privacy.test.ts`.

## Privacy

Raw content — `copilot_chat.user_request`, `gen_ai.input.messages`,
`gen_ai.output.messages`, system instructions, tool arguments/results, hook
input/output, reasoning content, file paths, commit hashes, branch names,
machine name, OS username, and developer email — **never leaves the machine**.
Only the aggregate batch contract
(`schemas/aggregate-batch.schema.json`) is uploaded, and only after explicit
opt-in. See `docs/architecture/` for the locked contracts and
`docs/privacy-validation.md` for the privacy checklist and how it is enforced
and tested.

The organization API key (format `aoa_<keyId>_<secret>`, provided by the
platform team) is set via **Agent Observability: Set Organization API Key** and
stored only in VS Code **SecretStorage** — never in `settings.json` or any
committed file. See `docs/architecture/api-auth.md`.

## Development

```bash
npm install        # install dev dependencies
npm run compile    # bundle to dist/extension.js via esbuild
npm run watch      # incremental dev build with sourcemaps
npm run typecheck  # tsc --noEmit (strict)
npm run lint       # eslint
npm test           # vitest (headless)
npm run package    # vsce package (.vsix)
```

Press <kbd>F5</kbd> in VS Code to launch an Extension Development Host and open
the **Agent Observability** view in the Activity Bar.

## Packaging the native module (`better-sqlite3`) — REQUIRED

The extension reads the local Copilot SQLite database via **`better-sqlite3`**, a
**native** (C++) Node module. Its compiled binary (`build/Release/*.node`) MUST
match the **VS Code Electron host's** Node ABI — **not** the system Node you ran
`npm install` with. If they differ, the extension fails to activate at runtime
with `ERR_DLOPEN_FAILED` / `NODE_MODULE_VERSION` mismatch. This requirement
carries over from Phase 2 (local SQLite ingestion).

When building a `.vsix` with `vsce package`, ensure a binary matching the target
Electron ABI is present:

- **Match the host ABI.** Determine the target VS Code's Electron version, then
  obtain a matching `better-sqlite3` binary by either:
  - **`electron-rebuild`** — `npx electron-rebuild -v <electronVersion> -f -w better-sqlite3`
    rebuilds the module against that Electron's headers; or
  - **a matching prebuild** — fetch the prebuilt binary for that Electron ABI
    (e.g. via `prebuild-install` with the correct `--runtime electron` and
    `--target <electronVersion>`).
- **Do not ship the system-Node binary.** A binary built for system Node will not
  load in the Electron host.
- **Keep the binary in the package.** `better-sqlite3` (and its
  `build/Release/*.node`) must NOT be excluded by `.vscodeignore`; it is a runtime
  `dependency`, not a dev dependency, and esbuild marks it `external` (it is not
  bundled), so the `node_modules` copy is what ships.
- **Multi-target.** To support multiple VS Code/Electron versions, produce one
  `.vsix` per target ABI (rebuild/prebuild per target) rather than assuming one
  binary works everywhere.

> Running `vsce package` is not required for this repo's CI; this section
> documents the packaging requirement so a release build is reproducible.

## Architecture seams

- `src/config/configuration.ts` — typed accessor over `agentObservability.*`
  settings. The only place that reads `vscode.workspace.getConfiguration`.
- `src/views/*.ts` — each `TreeDataProvider` exposes a private `getRootItems()`
  data seam where real data plugs in, and a `refresh()` event emitter.
- `src/commands/index.ts` — command ids and handler registration.
- `src/telemetry/*` — read-only SQLite snapshot + safe-metadata queries.
- `src/aggregate/*` — aggregate engine, pseudonymizer, and the privacy contract test.
- `src/consent/*`, `src/secrets/*`, `src/sync/*` — consent gating, SecretStorage key, and upload.
