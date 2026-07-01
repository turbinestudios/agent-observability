# Claude Code ingestion

This extension reads two agent-telemetry sources and shows them in one unified
set of views: **GitHub Copilot** (the local SQLite `agent-traces.db`) and
**Claude Code** (the JSON-lines transcripts Claude Code writes under
`~/.claude/projects`). This document covers the Claude Code path; it mirrors the
reference extension [`yessGlory17/argus`](https://github.com/yessGlory17/argus)
(read the JSONL transcripts, parse every tool call / prompt / token) but feeds the
extension's existing model layer rather than a bespoke dashboard.

## Where the data lives

```
<config>/projects/<encoded-cwd>/<sessionId>.jsonl                       ← main transcript
<config>/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl  ← sub-agent side-chains
```

`<config>` is `~/.claude` by default, honoring the `CLAUDE_CONFIG_DIR` env var and
the `agentObservability.claudeCode.projectsPath` override. The `<encoded-cwd>`
directory name is lossy, so the real working directory is read from the `cwd`
field inside the records, not decoded from the path.

### Record shape (validated against real transcripts)

Each line is one JSON record with a `type`. The telemetry-bearing types are
`user` and `assistant`; the rest are metadata (`ai-title`, `agent-name`, `mode`,
`permission-mode`, `system`, `attachment`, `file-history-snapshot`, `summary`).

- `assistant.message` = `{ id, model, usage, content[], stop_reason }`.
- `usage` = `input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
  `cache_read_input_tokens` (+ a `cache_creation` 5m/1h split).
- `content` blocks: `text`, `thinking`, `tool_use` (`{id,name,input}`),
  `tool_result` (`{tool_use_id,content,is_error}`).
- Every record carries `cwd` + `gitBranch`.
- Sub-agent side-chains live under `<sessionId>/subagents/`; the parent's
  `Task`/`Agent` tool result carries `agentId`, `agentType`
  (`Explore`/`Plan`/`general-purpose`), and the spawn's `totalTokens`.

## Module layout (`src/claude/`)

| Module | Responsibility |
|---|---|
| `transcript.ts` | Defensive types for the JSONL records (every field optional). |
| `parser.ts` | Streaming JSONL parser; skips blank/truncated lines (live-written files). |
| `paths.ts` | Bounded recursive discovery; groups main + sub-agent files per session. |
| `gitRemote.ts` | Resolve the SANITIZED repository from `cwd` via `.git/config` (worktree-aware). |
| `pricing.ts` | Token×rate USD cost in integer micro-USD (opus $5/$25, sonnet $3/$15, haiku $1/$5, fable $10/$50; cache-read 0.1×, cache-write 1.25×). |
| `mapper.ts` | Map records → the shared model shapes (`telemetry/models.ts`). |
| `claudeCodeService.ts` | `SessionDataSource` facade: discovery + mtime-keyed parse/summary caches. |

## How it plugs into the existing architecture

The Claude path produces the **same** model shapes as the Copilot path
(`SessionSummary` / `SessionDetail` / `Interaction` / `OverviewMetrics` /
`AggregationRow`). A source-agnostic `SessionDataSource` interface
(`src/sources/sessionSource.ts`) is implemented by a Copilot adapter (wrapping
`TelemetryService`) and by `ClaudeCodeService`; a `SourceRegistry` holds both.

- **Sessions view** — three levels when more than one source is enabled
  (source → repository → session); the source level is elided for a single
  source so the original Copilot layout is preserved.
- **Overview view** — merges metrics across sources, with a per-source breakdown.
- **Session-detail webview** — reused verbatim. The cost basis follows the source
  via a `CostMode`: Copilot shows AIU (`aiuToUsd`), Claude shows the token-priced
  USD estimate carried on `costUsdMicros`. Both sources drive the deviation and
  **Context Analysis** passes; each source owns producing its own context analysis
  via the optional `SessionDataSource.getContextAnalysis` (Copilot from OTel span
  attributes, Claude from the transcript + on-disk `.claude`/CLAUDE.md tree — see
  below). The shared per-agent pipeline (`context/contextAnalyzer.ts`) is reused by
  both via `buildAgentAnalysisFromParts` / `buildTotalAnalysis`.

### Context Analysis (Claude path)

Claude Code emits no discovery telemetry, so `claude/claudeContextAnalyzer.ts`
reconstructs the loaded-context set (`claude/claudeContextDiscovery.ts`):

- **Always-in-context** — every `CLAUDE.md` / `CLAUDE.local.md` from the session
  `cwd` up to the filesystem root, plus the user `~/.claude/CLAUDE.md`.
- **On-invocation** — context-directory `Read` tool calls, `Skill` invocations
  (each loads a `SKILL.md`), and per-sub-agent definition files (`.claude/agents/<type>.md`).
- **Token budget** — per agent, the largest `input_tokens + cache_read + cache_creation`
  across its turns (true window occupancy, since Claude serves most of a prompt from
  cache). Per-file sizes are estimated from disk (`≈ chars/4`).

Caveats (surfaced as a caption on the tab, `SessionContextAnalysis.note`): the
filesystem is read at analysis time, so it reflects the **current** on-disk state,
not the exact bytes present during the run (Copilot's is point-in-time); skills and
sub-agent definitions are counted as loaded only when invoked. Everything stays
LOCAL-ONLY — none of it reaches the cloud-aggregate `AggregationRow`.

### Mapping semantics (mirrors the Copilot mapping)

- An LLM call = one `assistant` message; a tool call = one `tool_use` block; a
  sub-agent spawn = a `Task`/`Agent` tool call → `invoke_agent`.
- `SessionSummary` counts the **main thread only** (so cross-session sums never
  double-count); `SessionDetail`'s tree rollups **include** sub-agents.
- Tokens live only on `chat` rows; `execute_tool` and `invoke_agent` rows carry 0,
  so summing never double-counts a sub-agent (its tokens are on its own `chat`
  rows). The repository groups Claude + Copilot sessions under the same node.

## Sync (org dashboard)

Claude aggregates feed the existing opt-in cloud sync. `ClaudeCodeService` emits
the **same** content-free `AggregationRow` shape, so a `CompositeAggregationSource`
(`src/sync/compositeAggregationSource.ts`) simply concatenates Copilot + Claude
rows into the `SyncEngine`. No `aggregate-batch.schema.json` change and no
dashboard change are needed: Claude rows commingle, distinguished by `model`
(`claude-*`) and `repository`. Claude sessions map to `agentMode: 'agent'`.

## Privacy

Raw transcript content (prompts, completions, tool I/O, file contents, branch
names) is read **only** for the local detail webview, HTML-escaped before display,
and never logged. `buildAggregationRows` / `buildInteractions` carry only
non-sensitive metadata (counts, tokens, sanitized repository, mapped tool/mode).
Repository URLs pass through the same `sanitizeRepositoryUrl` chokepoint as the
Copilot path, so credential-bearing remotes cannot reach a view or an aggregate.

## Performance & limits

Transcripts are parsed on demand and memoized by file mtime. A developer can
accumulate thousands of sessions, so the Sessions list and the default sync set
are bounded to the `agentObservability.claudeCode.maxSessions` (default 150)
most-recently-active sessions; the count of older sessions is surfaced as an info
row (`truncationNote`) rather than dropped silently.

## Settings

| Key | Default | Purpose |
|---|---|---|
| `agentObservability.claudeCode.enabled` | `true` | Capture Claude Code sessions. |
| `agentObservability.claudeCode.projectsPath` | `""` | Override the `projects` directory. |
| `agentObservability.claudeCode.scanDepth` | `8` | Max project-tree scan depth (the `subagents/` subtree is always scanned in full). |
| `agentObservability.claudeCode.maxSessions` | `150` | Most-recent sessions surfaced/aggregated. |

## Not yet implemented (follow-up)

A near-real-time **live watcher** for Claude (Argus's "Live Session Watcher").
The existing live banner is wired to GitHub Copilot's OpenTelemetry file exporter
only; Claude sessions get full detail after a run (a refresh re-discovers them).
Adding an `fs.watch` over the active transcript that recomputes a live snapshot
and reuses the existing `postMessage({type:'liveUpdate'})` banner contract is the
natural next step.
