# 8. Rework & churn quality signals

## User story

As a developer assessing run quality, I want sessions scored for rework
(files rewritten repeatedly, lines added and then removed again, aborted turns),
so that I can tell productive runs from thrashing and study what triggers
the thrashing.

**Acceptance criteria**

- A session where churn signals cross thresholds (for example: the same file
  edited in 3 or more distinct turns, or a large share of added lines removed
  again within the same session) gets a "rework" indicator in the list and in
  the detail header.
- The detail Timeline marks the turns where churn concentrated (a file
  touched again, net-negative edits).
- The Dashboard shows a "highest-churn sessions" list for the window, each
  linking to the session detail.
- Thresholds are explained in a tooltip and adjustable via config keys (no
  settings UI required initially).
- Everything is computed locally; nothing is synced.

## Why this matters for research

This is the product's first outcome-quality proxy. Today every metric measures
*activity* (tokens, calls, lines written), so a session that wrote 900 lines
by rewriting the same function nine times looks like the most productive run
of the week. Churn separates "wrote a lot" from "thrashed", and correlating
flagged sessions with their prompts, models, and context files (proposal 3) is
precisely the research loop this product exists for.

## Agent spec

**Goal.** Add a core rework-analysis module computing per-session and
per-turn churn signals from data already parsed, persist the per-session
result in the index, and surface it in list, detail, and Dashboard.

**Grounding: what already exists**

- Per-turn line accounting already flows through core: `SessionTurn` and
  `SessionModelTurnPoint` carry `linesOfCode`, `linesOfDoc`,
  `linesOfCodeRemoved`, `linesOfDocRemoved`
  (`src/core/agent-observability-core/src/telemetry/models.ts`), produced by
  `src/core/agent-observability-core/src/telemetry/locAnalysis.ts`
  (`classifyExtension`, `countLines`; per-tool handling around lines
  147–165). A coarse churn ratio (removed/added) needs **no new parsing**.
- File-level signals:
  - Claude: `ToolUseResult.structuredPatch` (typed at
    `src/core/agent-observability-core/src/claude/transcript.ts:164`) plus
    the mapper's `ExtractedTool` (`filePath`, `oldString`, `newString`) in
    `src/core/agent-observability-core/src/claude/mapper.ts`: enough for
    per-file, per-turn add/remove attribution and added-then-removed line
    matching.
  - Copilot: `gen_ai.tool.call.arguments` is already read for LoC counting in
    `locAnalysis.ts`; extend that parse to also record the target file path
    per edit (the arguments contain it; `locAnalysis` currently extracts it
    for classification and drops it).
- Where computation belongs: **core**, host-independent: a new
  `src/core/agent-observability-core/src/analysis/rework.ts` with vitest
  tests beside it, consumed by both the desktop indexers and (later, if
  wanted) the extension. Importing `vscode` there is a lint error by design.
- Persistence: new columns on the desktop index `sessions` table (for
  example `rework_score`, `churn_added`, `churn_removed`,
  `refiled_count`) with a `SCHEMA_VERSION` bump in
  `src/desktop/agent-observability-desktop/src/datahost/indexer/indexDb.ts`
  (drop-and-rebuild is the migration).
- Surfacing: list rows in `views/sessions/SessionsView.tsx`; detail header
  and per-turn markers render inside core's
  `views/sessionDetailHtml.ts` (extend the turn header, following the
  deviation-card pattern around lines 1279–1310); Dashboard list in
  `views/overview/OverviewView.tsx` fed by an `overview()` extension.

**Implementation outline: two stages (ship Stage 1 alone if needed)**

1. **Stage 1: coarse, no new parsing.** In `analysis/rework.ts`, compute
   from existing turn data: session churn ratio
   (`linesRemoved / max(1, linesAdded)`), turns with net-negative code
   change, and (from the tool entries core already extracts) the count of
   files edited in 3+ distinct turns. Combine into a small typed result
   (`ReworkAnalysis { score, refiledFiles, churnRatio, flaggedTurnIndices }`)
   with documented, config-overridable thresholds (new
   `agentObservability.analysis.*` keys following the pattern in
   `src/core/agent-observability-core/src/config/configuration.ts`).
2. **Stage 2: fine, Claude first.** Use `structuredPatch` to match lines
   added in one turn and removed in a later turn of the same session
   (normalize whitespace; exact-line matching is sufficient, since this is a
   proxy, not a diff algorithm). Fold into the same `ReworkAnalysis` shape so
   the UI does not change.
3. **Indexers.** Run the analysis during hydration in both indexers, persist
   the per-session columns, extend `SessionRow` in `shared/rpc.ts`.
4. **UI.** Rework badge (list + detail header, with a tooltip naming the
   thresholds), per-turn markers in the detail Timeline, and a
   "Highest-churn sessions" list on the Dashboard (top 5 for the window,
   linking into detail).
5. **Changelog + version.** Minor bump; `### Added` entry in user terms
   ("Sessions that rewrote the same code repeatedly are now flagged…").

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these). File
paths and patch content are raw content: they stay in local analysis, never
in any aggregate/sync path. Only derived numbers may even be persisted in
the local index. Keep the analysis pure and synchronous in core; the datahost
owns scheduling.

**Out of scope.** Cross-session rework (edits reverted in a *later* session),
git-history correlation (`copilot_chat.repo.head_commit_hash` is classified
borderline; leave it untouched), test-result parsing, any claim of measuring
"quality" beyond a clearly-labeled proxy.

**Verification**

- Core unit tests with fixture transcripts: a session rewriting one file
  across several turns scores high; a linear write-once session scores near
  zero; threshold overrides via config are honoured; Stage 2 catches an
  add-then-remove sequence a coarse ratio misses.
- `npm run typecheck --workspaces --if-present` and
  `npm test --workspaces --if-present` (core touched), plus the desktop
  workspace commands.
- Manual: find a real session you know thrashed: it should be flagged and
  its flagged turns should match your memory of where it went sideways; the
  Dashboard list links to it.
