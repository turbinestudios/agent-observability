# Onboarding to Agent Observability (Extension-First)

Agent Observability is **privacy-first** and **extension-first**. You install a
local VS Code extension that reads your GitHub Copilot agent telemetry from an
on-disk SQLite database. **Raw content (prompts, responses, tool I/O,
source-file paths, file contents, identities) never leaves your machine.** Only
**opt-in, aggregated, non-sensitive** statistics — plus, for context-engineering
hotspots, the **repository-relative paths of customization files**
(instructions/skills/prompts/agents/hooks) with counts only — are ever shared
with your organization dashboard.

There is **no OpenTelemetry collector, no OTLP endpoint, no
`OTEL_EXPORTER_OTLP_*` environment variables, and no committed
`.vscode/settings.json`** in this flow. The previous collector-based onboarding
is archived (one release, rollback only) at
[`docs/legacy/onboarding-otel-collector.md`](legacy/onboarding-otel-collector.md).

## Prerequisites

- VS Code with the GitHub Copilot extension installed and used (so a local
  Copilot agent telemetry database exists on your machine).
- The **Agent Observability (Local)** VS Code extension (see Step 1).
- *Only if you want to contribute org aggregates:* an **organization API key**
  from your platform team (key format `aoa_<keyId>_<secret>`). The dashboard URL
  is built into the extension — there is nothing to configure.

## Step 1: Install the extension

Install **Agent Observability (Local)** from
`src/extension/agent-observability-vscode`.

- From a packaged build: `code --install-extension agent-observability-<version>.vsix`.
- From source for development: open the folder in VS Code and press
  <kbd>F5</kbd> to launch an Extension Development Host. See the extension
  [`README.md`](../src/extension/agent-observability-vscode/README.md) for build
  and native-module packaging notes.

Once installed, open the **Agent Observability** container in the Activity Bar.
You will see three views: **Local Overview**, **Sessions**, and **Sync**.

## Step 2: View your local activity (no configuration needed)

The extension **auto-detects** the local Copilot `agent-traces.db` SQLite
database (override with `agentObservability.sqlitePath` only if auto-detect
fails). It opens the file **read-only** and shows:

> **Copilot has to be writing that database first.** Copilot Chat creates
> `agent-traces.db` lazily, and only while its SQLite span exporter is enabled —
> which is **off by default**. A machine can use Copilot daily and still have no
> database at all. Turn it on in VS Code settings, then chat with Copilot once:
>
> ```jsonc
> "github.copilot.chat.otel.dbSpanExporter.enabled": true
> ```
>
> The file lands in the extension's `globalStorage`, e.g. on macOS
> `~/Library/Application Support/Code/User/globalStorage/github.copilot-chat/agent-traces.db`.
> Auto-detect scans the equivalent path for every VS Code–based editor
> installed (stable, Insiders, Cursor, VSCodium, …).
>
> The **desktop app** (1.10.0+) checks this at every launch and can add the
> setting for you — accept the offer it shows when nothing is being recorded,
> or use the per-editor **Enable** button in its Settings. Fully restart the
> editor afterwards.

- **Local Overview** — a summary of your local Copilot agent activity.
- **Sessions** — your local agent sessions with prompt, tool, model, duration
  and success detail. **This detail is local-only** and is never uploaded.
- **Copilot (Cloud)** *(opt-in)* — your GitHub Copilot **cloud coding-agent**
  sessions, shown as their own source beside *Copilot* and *Claude Code*. Enable
  it with the `agentObservability.copilotCloud.enabled` setting. A background
  poller pulls your cloud-agent task/session logs (prompt, state, tool timeline,
  model, AI-credit cost) via the GitHub API into a local sink and renders them
  like any other session. Authentication uses the **`gh` CLI** (signed in via
  `gh auth login`), or you can supply a token directly with the **Copilot
  (Cloud): Set account token** command. Which accounts are polled is pinned via
  `agentObservability.copilotCloud.accounts` (leave empty to capture the active
  `gh` login once, or list usernames to poll several) — so a `gh auth switch`
  never silently changes what you see. These sessions are **pulled down and
  rendered locally only** and are never uploaded.

Nothing is uploaded at this stage. No OTLP settings, no env vars, and no
workspace `.vscode/settings.json` are required. (Optional: configure expected
per-repository workflows in the `agentObservability.workflows` setting to enable
the on-machine deviation detector — this also runs entirely locally.)

## Step 3 (optional): Contribute org aggregates

Sharing is **opt-in and OFF by default**. The dashboard URL is **built into the
extension**, so there is no endpoint to configure. To contribute aggregate
analytics to your organization dashboard:

1. **Open the Sync view** in the Agent Observability container.
2. **Enable Cloud Sharing.** Run **Agent Observability: Toggle Cloud Sharing**
   (or use the Sync view). A consent dialog states exactly **what is shared**
   vs **not shared** (see below). This flips `agentObservability.sync.enabled`
   to `true`.
3. **Set the Organization API key.** Run **Agent Observability: Set
   Organization API Key** and paste the key (`aoa_<keyId>_<secret>`). It is
   stored only in **VS Code SecretStorage** (OS keychain / Windows Credential
   Manager / libsecret). It is **never** written to `settings.json`, any
   committed file, or logs.
4. **(Optional) Enable background sync.** With consent on and a key set,
   background uploads run on `agentObservability.sync.intervalMinutes` (default
   60, minimum 5). You can also push on demand with **Agent Observability: Sync
   Now**.

> Sync is blocked unless **both** consent is on **and** an API key is present.
> Turning consent off stops all uploads immediately.

### Preview exactly what would be uploaded

Run **Agent Observability: Preview Aggregate Payload** to inspect the exact
aggregate batch (the only thing ever sent) before any upload.

## Step 4: Verify aggregates arrive

1. With sharing on and a key set, run **Agent Observability: Sync Now**.
2. The **Sync** view shows the last sync status (success/failure, counts).
3. In the org dashboard, confirm your org's aggregate analytics update (filtered
   by repo / model / mode / tool). Your contribution appears under a
   **pseudonymous developer id** — never your name or email.

### Troubleshooting

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| Local views empty | No local telemetry DB found | Use Copilot agent features once; or set `agentObservability.sqlitePath`. Ensure `agentObservability.localTelemetry.enabled` is `true`. |
| Sync never runs | Consent off or no key | Toggle Cloud Sharing on **and** set the Organization API key. |
| Upload rejected (401) | Bad/expired API key | Re-run **Set Organization API Key** with a current `aoa_<keyId>_<secret>` from the platform team. |
| Upload rejected (400) | Schema/validation failure | The server enforces the aggregate contract strictly; update the extension. See [`docs/privacy-validation.md`](privacy-validation.md). |
| Upload rejected (503) | Ingestion disabled server-side | Platform team must set `Ingestion:Enabled=true` on the dashboard. |
| Copilot (Cloud) empty — "GitHub CLI not found" | `gh` not on PATH | Set `agentObservability.copilotCloud.ghCliPath` to the `gh` executable, or set a token per account via **Copilot (Cloud): Set account token**. |
| Copilot (Cloud) empty — "not signed in" / token expired | Account not authenticated | Run `gh auth login` for that account, or supply a token with **Copilot (Cloud): Set account token**. |

## What is shared vs NOT shared

**Shared** (aggregate, non-sensitive measures only):

- **Usage aggregates:** aggregate **counts**, token totals
  (input/output/cached/reasoning), and **latency buckets** per **30-minute
  bin**, grouped by **repository**, **model**, **agent mode**, and **tool**,
  under a **pseudonymous developer id**.
- **Context-engineering hotspots:** for **customization files only**
  (instructions, skills, prompts, agents, hooks) — their **repository-relative
  path**, category, and per-30-minute-bin **counts** (applied / skipped, an
  estimated token size derived from file **size** only, and how many sessions
  saw an error or workflow deviation while the file was applied). Skip reasons
  are reduced to a fixed taxonomy (`applyToNoMatch` / `other`) — never the raw
  reason text.

**NOT shared** (never leaves your machine): no prompts, no responses, no file
contents, **no source- or document-file paths**, no commit hashes, no branch
names, no machine name, no OS username, and no email or personal identity. Only
customization-file paths (above) are shared — path plus counts, never contents.

**Copilot (Cloud) sessions are local-only.** When the cloud source is enabled,
its task/session logs are *pulled DOWN* from the GitHub API and rendered on your
machine, but they are **never uploaded** by this extension — the cloud source
contributes nothing to the aggregate batch (its `getAggregationRows` returns an
empty set in the current phases). Raw cloud prompts, tool I/O, and assistant
text live only in the local sink under your home directory.

Two strict contracts are the only payloads uploaded — the aggregate batch
([`schemas/aggregate-batch.schema.json`](../schemas/aggregate-batch.schema.json))
and the context-insights batch
([`schemas/context-insights-batch.schema.json`](../schemas/context-insights-batch.schema.json))
— both locked with `additionalProperties: false` at every level and re-validated
server-side. The full privacy guarantee and how it is enforced/tested is
documented in [`docs/privacy-validation.md`](privacy-validation.md).

## Reference

- Architecture & contracts: [`docs/architecture/`](architecture/) —
  [aggregate payload schema](architecture/aggregate-payload-schema-v1.md),
  [API auth lifecycle](architecture/api-auth.md),
  [pseudonymization strategy](architecture/pseudonymization-strategy.md).
- Migrating off the legacy collector flow: [`docs/migration.md`](migration.md).
- Extension settings & commands: the extension
  [`README.md`](../src/extension/agent-observability-vscode/README.md).
