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
| Local session detail timeline + per-request workflow deviation detection (with optional notifications) | Shipped |
| Real-time updates via a localhost OTLP receiver (Copilot `otlp-http` → extension sink) | Shipped |
| Workflow predicate DSL (metadata + local-only content predicates) | Shipped |
| Consent toggle + organization API key in SecretStorage (opt-in, off by default) | Shipped |
| Aggregate engine (30-min time bins, pseudonymous developer id, idempotent batch/row ids) | Shipped |
| Upload to the dashboard ingestion API with retry/backoff | Shipped |
| AI Helper — Copilot-backed chat for config & log summaries | Shipped |

All raw content stays on the machine; only opt-in aggregate batches are uploaded.

## Views

- **Local Overview** — summary of local Copilot agent activity.
- **Sessions** — list and drill into local agent sessions (local-only detail).
- **Sync** — consent status and upload of opt-in aggregate batches.
- **AI Helper** — a chat assistant backed by your own GitHub Copilot license (see below).

## AI Helper

The **AI Helper** is a chat view (in the Agent Observability activity-bar container)
that answers questions about this extension and your local telemetry using **your
own GitHub Copilot license** (`vscode.lm`). It is grounded in concise context files
baked into the extension, so it knows this extension's settings, the workflow DSL,
and the telemetry model. An empty chat offers three quick-command buttons:

- **Generate workflows** — drafts an `agentObservability.workflows` array from your
  project's **Copilot customization files** (instructions, agents, prompts, skills),
  using the agents they declare, the order they run in, and the tools they use. The
  repository is taken from the workspace's git remote. The result can be applied to
  `.vscode/settings.json` behind a confirmation; it is validated against the same
  parser the deviation detector uses and **merged** by repository (your other
  repositories' entries are kept).
- **Set up new project** — produces the bare-minimum `.vscode/settings.json` to get
  the extension working. Only known `agentObservability.*` keys are applied; the
  organization API key is never written to settings (use the command instead).
- **Summarize my logs** — a detailed natural-language summary of your collected
  telemetry.

You can also type free-text questions. Generated configuration always has a **Copy**
button, and a settings-bound one has an **Apply** button.

**Requires GitHub Copilot.** If Copilot isn't installed or signed in, the AI Helper
says so. On first use it shows a one-time disclosure (below) and VS Code's own
Copilot-access prompt.

**Privacy.** The AI Helper sends **safe metadata** — sanitized repository names,
agent/model/tool names, durations, and token/AIU counts — plus your typed prompt, to
your own Copilot model. The **Generate workflows** command additionally reads your
project's Copilot customization files (instructions, agents, prompts, skills) and
sends their **contents** so it can infer the intended workflow — these are your own
files going to your own Copilot license. It never sends raw prompts/responses, tool
input/output, or session titles, and it never touches the cloud-sync path. This is a
distinct gate from cloud sharing (which stays off by default).

## Commands

All under the **Agent Observability** category:

- `Agent Observability: Refresh`
- `Agent Observability: Sync Now`
- `Agent Observability: Open Settings`
- `Agent Observability: Set Organization API Key`
- `Agent Observability: Choose Repositories to Sync`
- `Agent Observability: Choose Repositories to Hide`
- `Agent Observability: Toggle Cloud Sharing`
- `Agent Observability: Open AI Helper`
- `Agent Observability: New AI Helper Chat`

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `agentObservability.sync.enabled` | `false` | Opt in to cloud aggregate sharing (opt-out by default). |
| `agentObservability.sync.intervalMinutes` | `60` | Background sync interval (minimum 5). |
| `agentObservability.sync.repositoryMode` | `"include"` | Which repositories cloud sync includes: `include` (only those listed — the default), `all`, or `exclude`. User-level only. |
| `agentObservability.sync.repositories` | `[]` | Repository URLs the mode applies to. With the default `include` mode and this list empty, nothing uploads until you pick at least one. Use **Choose Repositories to Sync** to pick from local telemetry. `unknown` matches sessions with no git remote. |
| `agentObservability.excludedRepositories` | `[]` | Repositories hidden from the WHOLE extension: their sessions disappear from the local views AND are excluded from sync/preview, regardless of the sync scope. Use **Choose Repositories to Hide** to pick interactively. `unknown` hides sessions with no git remote. Local data is untouched — removing an entry brings the repository back. |
| `agentObservability.localTelemetry.enabled` | `true` | Feature flag for the local telemetry view. |
| `agentObservability.sqlitePath` | `""` | Override path to `agent-traces.db` (blank = auto-detect). |
| `agentObservability.deviation.maxSessionMinutes` | `60` | Local deviation detector: max expected session/turn duration. |
| `agentObservability.deviation.notifyOnDivergence` | `false` | Raise a VS Code notification when a configured workflow diverges within a user-request turn. Per-turn divergences always show inline in the timeline regardless. |
| `agentObservability.workflows` | `[]` | Optional per-repository expected workflows for the local deviation detector. Evaluated on-machine; never uploaded. |
| `agentObservability.liveUpdates.enabled` | `false` | Run a localhost OTLP receiver and use the extension's own ingested DB as the live source. Turn on via **Enable Live Updates (Copilot OTel)** (requires a full VS Code restart). |
| `agentObservability.liveUpdates.otelPort` | `0` | Localhost port the OTLP receiver listens on (set automatically by the enable command). |
| `agentObservability.liveUpdates.debounceMs` | `400` | Coalescing window between ingesting spans and refreshing the views (minimum 100). |

## Real-time updates (Copilot OTLP)

Run **Agent Observability: Enable Live Updates (Copilot OTel)** to stream Copilot's
telemetry to the extension in real time. It points Copilot Chat's OpenTelemetry
`otlp-http` exporter at a private `http://127.0.0.1:<port>` receiver the extension
runs; each pushed span is written into the extension's OWN SQLite database — Copilot's
exact `agent-traces.db` schema — so the session views, the per-request workflow
deviation detector, and the divergence notifications all update live off one source,
with no snapshot polling or WAL lag.

The extension becomes the telemetry **sink**: while live updates are on, Copilot's own
`agent-traces.db` is no longer fed (a single exporter is active), so the extension reads
its own DB instead. The receiver binds loopback (`127.0.0.1`) only and nothing is
uploaded. Because Copilot reads its OTel settings at **application startup**, you must
fully **quit and reopen VS Code** after enabling — a window reload is not enough. Use
**Disable Live Updates** to revert.

With **multiple VS Code windows** open, exactly one window runs the receiver (Copilot
exports to a single machine-wide endpoint): the first window to bind the port wins and
writes the shared ingest DB; every other window automatically follows it as a reader —
same data, refreshed on the receiver's push — and takes the port over if the receiver's
window is closed. No configuration is needed; the election is automatic.

## Workflow predicate DSL

`agentObservability.workflows` lets you describe the agent workflows you expect
per repository so the **local** deviation detector can flag sequence, missing,
timeout, and failure-rate anomalies. Detection is **per user-request turn** (one
request plus everything the agent spawned for it): each turn is checked
independently, any divergence is shown inline on that request in the
session-detail timeline, and — when `deviation.notifyOnDivergence` is on — also
raised as a VS Code notification. There are two tiers of matching, and both run
entirely on your machine.

**Tier 1 — metadata predicates (safe).** A `StepPredicate` filters the safe
interaction metadata: `operation`, `agentName`, `agentMode`, `model`,
`toolName`, `success`. Every field is optional (absent = match any); strings
compare case-insensitively. Use them in `steps[].predicate` and in an optional
`triggerPredicate`, which acts as a pure **applicability gate**: the workflow
applies to a turn when an interaction matches it, then its steps are verified as
an ordered (not necessarily adjacent) subsequence over the whole turn. The legacy
`expectedSequence` (an ordered list of agent names) still works and is the
degenerate case of `steps`. Scope by a real discriminator (`operation`,
`toolName`, `model`, or a sub-agent `agentName`) — never `agentMode` alone, since
every custom chat mode collapses to `agentMode: "custom"`.

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
backtracking cost. Prefer `contains` for simple checks. A `triggerContentPredicate`
(same shape, on the workflow itself) can additionally gate *applicability* on the
request's intent — e.g. `copilot_chat.user_request` contains a phrase — for
workflows no metadata signal can distinguish; such a workflow is evaluated only
locally per turn and never participates in sync.

```jsonc
"agentObservability.workflows": [
  {
    "repository": "https://github.com/org/repo",
    "workflows": [
      {
        "name": "feature-development",
        "triggerPredicate": { "operation": "invoke_agent" },
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

## AIU usage & cost

Click a session in the **Sessions** view to open its detail panel. The **Agent
run totals** card and the **Main agent** / **Spawned sub-agents** tables show the
**AIU** (Copilot premium-request units) recorded for each scope, with the derived
dollar cost shown inline next to it (e.g. `536.26 ($5.36)`).

> **AIU is the billed unit — cost is derived from it, not estimated.** Unlike a
> token×rate estimate, AIU is the quantity GitHub Copilot actually records on each
> `chat` span (`copilot_chat.copilot_usage_nano_aiu`). Cost is simply that AIU
> converted at the fixed published rate of **1 AIU = $0.01 USD**. There is nothing
> to configure.

**What you'll see.**

- A scope with no billed AIU → `0` (no dollar figure — it was not billed).
- A billed scope → its AIU with the inline cost, e.g. `2.04 ($0.02)`.
- The footer/totals sum each table's AIU and show the combined cost the same way.

**Privacy.** AIU and all derived cost figures stay entirely on your machine.
Nothing about cost or per-session usage is ever added to the opt-in aggregate
batch — this is a local-only display.

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

## Packaging the SQLite engine (`node-sqlite3-wasm`)

The extension reads the local Copilot SQLite database via **`node-sqlite3-wasm`**,
a **WebAssembly** build of SQLite. Because it is WASM and not a native (C++) addon,
it has **no compiled `.node` binary and no Node/Electron ABI to mismatch** — a
single `.vsix` activates correctly across every VS Code version, regardless of the
Electron/Node ABI of the host. (This replaced `better-sqlite3`, whose native
binary had to match the host ABI and caused `ERR_DLOPEN_FAILED` /
`NODE_MODULE_VERSION` failures when the `.vsix` was installed on a VS Code whose
Electron differed from the build machine's Node.)

Packaging notes:

- **It is `external`, not bundled.** esbuild marks `node-sqlite3-wasm` external
  because the JS loader locates its `.wasm` sidecar relative to its own
  `__dirname`; bundling the JS into `dist/extension.js` would break that lookup.
- **Keep it in the package.** `.vscodeignore` re-includes
  `node_modules/node-sqlite3-wasm/**` (the `dist/node-sqlite3-wasm.js` loader plus
  the `dist/node-sqlite3-wasm.wasm` binary) so the runtime `require` resolves at
  runtime. It is a runtime `dependency`, not a dev dependency.
- **No per-target builds.** Unlike a native module, you do **not** rebuild per
  Electron version — one `.vsix` works everywhere.

> Running `vsce package` is not required for this repo's CI; this section
> documents the packaging shape so a release build is reproducible.

## Architecture seams

- `src/config/configuration.ts` — typed accessor over `agentObservability.*`
  settings. The only place that reads `vscode.workspace.getConfiguration`.
- `src/views/*.ts` — each `TreeDataProvider` exposes a private `getRootItems()`
  data seam where real data plugs in, and a `refresh()` event emitter.
- `src/commands/index.ts` — command ids and handler registration.
- `src/telemetry/*` — read-only SQLite snapshot + safe-metadata queries.
- `src/aggregate/*` — aggregate engine, pseudonymizer, and the privacy contract test.
- `src/consent/*`, `src/secrets/*`, `src/sync/*` — consent gating, SecretStorage key, and upload.
