# Claude Code ingestion

Agent Observability reads several agent-telemetry sources and shows them in one
unified set of views, among them **GitHub Copilot** (the local SQLite
`agent-traces.db`) and **Claude Code** (the JSON-lines transcripts Claude Code
writes under `~/.claude/projects`). The Claude Code reader lives in the shared core
package (`src/core/agent-observability-core`) and is run by the desktop app. This
document covers the Claude Code path. It follows the
approach of [`yessGlory17/argus`](https://github.com/yessGlory17/argus)
(read the JSONL transcripts, parse every tool call, prompt and token) but feeds the
shared model layer rather than a separate dashboard.

## Where the data lives

```
<config>/projects/<encoded-cwd>/<sessionId>.jsonl                       ← main transcript
<config>/projects/<encoded-cwd>/<sessionId>/subagents/agent-<id>.jsonl  ← sub-agent side-chains
```

`<config>` is `~/.claude` by default, honoring the `CLAUDE_CONFIG_DIR` env var and
the `claudeCode.projectsPath` override. The `<encoded-cwd>`
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

## Module layout (`src/core/agent-observability-core/src/claude/`)

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
(`sources/sessionSource.ts`) is implemented by a Copilot adapter (wrapping
`TelemetryService`), by `ClaudeCodeService`, and by the other sources; the
desktop's data host holds them all in one `SourceRegistry`
(`src/desktop/agent-observability-desktop/src/datahost/index.ts`) and indexes
Claude sessions into its local index
(`src/desktop/agent-observability-desktop/src/datahost/indexer/claudeIndexer.ts`).

- **Sessions:** Claude sessions are listed alongside the other sources.
- **Overview:** merges metrics across sources, with a per-source breakdown.
- **Session detail:** shared across sources. The cost basis follows the source
  via a `CostMode`: Copilot shows AIU (`aiuToUsd`), Claude shows the token-priced
  USD estimate carried on `costUsdMicros`. Both sources drive the deviation and
  **Context Analysis** passes; each source produces its own context analysis
  via the optional `SessionDataSource.getContextAnalysis` (Copilot from OTel span
  attributes, Claude from the transcript + on-disk `.claude`/CLAUDE.md tree, see
  below). The shared per-agent pipeline (`context/contextAnalyzer.ts`) is reused by
  both via `buildAgentAnalysisFromParts` / `buildTotalAnalysis`.

### Context Analysis (Claude path)

Claude Code emits no discovery telemetry, so `claude/claudeContextAnalyzer.ts`
reconstructs the loaded-context set (`claude/claudeContextDiscovery.ts`):

- **Always-in-context:** every `CLAUDE.md` / `CLAUDE.local.md` from the session
  `cwd` up to the filesystem root, plus the user `~/.claude/CLAUDE.md`.
- **On-invocation:** context-directory `Read` tool calls, `Skill` invocations
  (each loads a `SKILL.md`), and per-sub-agent definition files (`.claude/agents/<type>.md`).
- **Token budget:** per agent, the largest `input_tokens + cache_read + cache_creation`
  across its turns (true window occupancy, since Claude serves most of a prompt from
  cache). Per-file sizes are estimated from disk (`≈ chars/4`).

Caveats (surfaced as a caption on the tab, `SessionContextAnalysis.note`): the
filesystem is read at analysis time, so it reflects the **current** on-disk state,
not the exact bytes present during the run (Copilot's is point-in-time); skills and
sub-agent definitions are counted as loaded only when invoked. The analysis
itself stays LOCAL-ONLY: none of it reaches the content-free `AggregationRow`.

### Mapping semantics (mirrors the Copilot mapping)

- An LLM call = one `assistant` message; a tool call = one `tool_use` block; a
  sub-agent spawn = a `Task`/`Agent` tool call → `invoke_agent`.
- `SessionSummary` counts the **main thread only** (so cross-session sums never
  double-count); `SessionDetail`'s tree rollups **include** sub-agents.
- Tokens live only on `chat` rows; `execute_tool` and `invoke_agent` rows carry 0,
  so summing never double-counts a sub-agent (its tokens are on its own `chat`
  rows). The repository groups Claude + Copilot sessions under the same node.

## Team shard

Nothing about Claude sessions leaves the machine unless the user turns on Team
sharing in the desktop app (off by default). `ClaudeCodeService` emits the
**same** content-free `AggregationRow` shape as the Copilot path, so the team
export (`src/desktop/agent-observability-desktop/src/datahost/team/teamShardSource.ts`)
simply concatenates the rows of every enabled source before building the
embedded aggregate batch. No `aggregate-batch.schema.json` change is needed:
Claude rows commingle, distinguished by `model` (`claude-*`) and `repository`.
Claude sessions map to `agentMode: 'agent'`. The shard's `outcomes` block counts
them under the source `claude`.

## Privacy

Raw transcript content (prompts, completions, tool I/O, file contents, branch
names) is read **only** for the local detail view, HTML-escaped before display,
and never logged. `buildAggregationRows` / `buildInteractions` carry only
non-sensitive metadata (counts, tokens, sanitized repository, mapped tool/mode).
Repository URLs pass through the same `sanitizeRepositoryUrl` chokepoint as the
Copilot path, so credential-bearing remotes cannot reach a view or an aggregate.
The AI features that can send session content to a vendor are the sanctioned,
user-initiated exceptions described in [`AGENTS.md`](../../AGENTS.md#privacy-invariant-do-not-break);
none of them is on the aggregate or team path.

## Performance & limits

Transcripts are parsed on demand and memoized by file mtime. A developer can
accumulate thousands of sessions, so `ClaudeCodeService`'s session list and its
aggregation rows (and so the team shard) are bounded to the
`claudeCode.maxSessions` (default 150) most-recently-active sessions; the count of
older sessions is surfaced as a note (`truncationNote`) rather than dropped
silently.

## Settings

The desktop app reads these ids from `~/.agent-observability/desktop/config.json`
(`src/desktop/agent-observability-desktop/src/datahost/drivers/desktopConfig.ts`);
its Settings screen exposes `claudeCode.enabled` and `claudeCode.projectsPath`.

| Key | Default | Purpose |
|---|---|---|
| `claudeCode.enabled` | `true` | Capture Claude Code sessions. |
| `claudeCode.projectsPath` | `""` | Override the `projects` directory. |
| `claudeCode.scanDepth` | `8` | Max project-tree scan depth (the `subagents/` subtree is always scanned in full). |
| `claudeCode.maxSessions` | `150` | Most-recent sessions surfaced/aggregated. |

## Live updates

The desktop's live board
(`src/desktop/agent-observability-desktop/src/datahost/live/liveBoard.ts`) uses
core's `live/claudeWatcher.ts` to watch the Claude `projects` directories for
`*.jsonl` changes. Each change signals a `LiveUpdateController`, which debounces
the burst into one recompute and, once the transcript has been quiet, requests a
re-index so the lists pick up the changed transcript. This needs no hooks and no
exporter configuration: Claude Code writes the transcripts anyway.
