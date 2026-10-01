# 9. Session retrospective

## User story

As a developer improving how I work with agents, I want every session to
answer the questions I actually ask after a run (what was the goal, did it
get done, where was the friction, was my prompt any good, and what should I
do differently next time), so that each session teaches me something instead
of just costing tokens.

**Acceptance criteria**

- Every analyzed session gets a verdict (went smoothly, some friction,
  struggled, or left unfinished) plus the goal it set out on and the
  moments that decided the verdict, each tied to the turn where it happened.
- The session detail shows the full retrospective: goal, verdict, findings
  with turn links, and at most three evidence-backed suggestions.
- The list marks sessions that struggled or were left unfinished, with a
  filter to see only those; a dedicated view ranks recent sessions by
  friction.
- "Unclear" is an allowed, honest outcome: the heuristics observe friction,
  not correctness, and never pretend otherwise.
- Everything heuristic is computed locally. Only counts and enum labels are
  persisted in the local index; the narrative is recomputed on demand.
- An **opt-in** deep retrospective can ask the user's own Claude Code CLI
  for a judged read (see Constraints; this is a sanctioned exception
  to the raw-content rule, double-gated behind a setting and a
  per-invocation confirmation).

## Why this matters for research

Proposal 8 framed rework/churn as "the product's first outcome-quality
proxy". This proposal extends that from *what happened* to *why it went that
way and what to change*: the correction re-prompts, user interruptions,
error streaks, context compactions, and prompt shape that explain a rough
session are all **already parsed and dropped today**. Feeding them back as a
retrospective closes the research loop this product exists for. It is the same
loop the Context Hotspots view (proposal 3) opened for instruction files,
now applied to the developer's own prompting and workflow.

## Agent spec

**Goal.** Add a pure core retrospective engine over data already parsed,
persist a compact counts projection in the desktop index, and surface it as
a detail card, list chips, a Retro view, and an opt-in CLI-judged deep
retrospective.

**Grounding: what already exists**

- `SessionDetail.turns` (`src/core/agent-observability-core/src/telemetry/models.ts`)
  already carries per-turn raw prompt text (`userRequest`), the final
  response, the tool-event sequence with success flags, tokens, and LoC
  added/removed. No new parsing is needed for most signals.
- Unread transcript signals in
  `src/core/agent-observability-core/src/claude/transcript.ts`: user records
  whose text starts with `[Request interrupted by user` (nothing detects
  interruptions today), `permissionMode` records (plan mode),
  `system`/`compact_boundary` records (context compaction),
  `isApiErrorMessage`. One caveat: interruption records pass the mapper's
  `isUserRequest`, so they surface as turns whose `userRequest` is the
  marker text, so the analyzer must treat those as interruptions, not prompts.
- `SessionTurn.durationMs` is always `0` for Claude sessions (the mapper
  never sets it); effective turn duration must be derived from the turn's
  `events` spans.
- The analysis home: `src/core/agent-observability-core/src/analysis/`;
  proposal 8 already earmarks this directory (`rework.ts`).
- Desktop pipeline template (proposal 3): background `AnalysisQueue` →
  `session_analysis` columns in
  `src/desktop/agent-observability-desktop/src/datahost/indexer/indexDb.ts`
  (SCHEMA_VERSION bump = drop-and-rebuild) → typed RPC rows → React view;
  the detail narrative is recomputed in `DetailRenderer` through the same
  helper the badge uses, so list and document can never disagree.
- CLI seam for the deep tier:
  `src/core/agent-observability-core/src/chat/backends/claudeCodeBackend.ts`
  and `claudeCliArgs.ts`: the user's own `claude` login, `--tools ""`,
  `--max-turns 1`, and crucially `--no-session-persistence` so the app never
  ingests its own analysis runs as new sessions.

**Implementation outline**

1. **Core engine.** `analysis/retrospective.ts`: pure
   `buildSessionRetrospective(detail, signals?)` producing goal + verdict
   (`smooth | bumpy | struggled | abandoned`) + outcome
   (`likely-fulfilled | partially | unclear | likely-unfulfilled`) +
   findings (correction re-prompts, repeated prompts, interruptions,
   tool-error streaks, rework churn, long-tail turns, compactions,
   sub-agent-heavy spend, plan-mode-skipped, first-prompt shape, abandoned
   ending) + at most three evidence-backed tips + a numbers-only counts
   projection. Ordinal verdicts, not scores: the heuristics are coarse
   proxies and a 0-100 number would imply precision they do not have.
2. **Claude signal extractor.** `claude/retrospectiveSignals.ts`: raw
   records in, counts/enums out (interruptions, compactions, plan mode, API
   errors, how the transcript ends). The content chokepoint, mirroring
   `telemetry/locAnalysis.ts`.
3. **Service seam.** `ClaudeCodeService.getSessionRetrospective` plus an
   optional `getSessionRetrospective?` on `SessionDataSource`, following
   `getContextAnalysis?`.
4. **Probe calibration.** A throwaway `probe-retrospective.ts` script runs
   the engine over the real local
   corpus and prints the verdict histogram plus the flagged sessions. If
   more than ~30% of a normal corpus reads struggled/abandoned, the
   thresholds are too hot; tune before wiring UI.
5. **Desktop.** Counts columns on `session_analysis`, verdict on
   `SessionRow` with a friction filter, the detail card following the
   deviation-summary pattern, and the Retro view following the Hotspots
   pattern. Deep retrospective behind a default-off setting and a
   per-invocation confirmation dialog.
6. **Changelog + version.** Minor bump, entries in user terms.

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these). The
whole retrospective is content-derived and LOCAL-ONLY: findings carry
generic descriptions and turn indices, never prompt or response text; only
the counts projection may reach the local `index.db`, and nothing from this
feature may touch `src/core/agent-observability-core/src/aggregate/*`,
`…/src/sync/*`, or `schemas/*.json`. **Deep retrospective exception**: the
opt-in deep tier sends the selected session's transcript digest to Anthropic
via the user's own local `claude` CLI login (since 1.14.0, alternatively the GitHub Copilot CLI to
GitHub, whichever Settings selects). It is permitted ONLY behind the
double gate (Settings toggle off by default + per-invocation confirmation
naming exactly what is sent), never in the background, and documented as a
narrow carve-out in `AGENTS.md` and `docs/privacy-validation.md`.

**Out of scope.** Per-file rework attribution (proposal 8 owns it, and
absorbs this module's coarse `sessionCodeChurn` helper when it lands);
config keys for thresholds until probe calibration demands them;
cross-session analysis; git-history correlation; any claim of measuring
"quality" beyond a clearly-labeled proxy; retrospectives inside the
combined comparison document.

**Verification**

- Core unit tests per detector, positive and negative, plus a privacy-style
  regression asserting the counts projection contains no prompt text.
- Probe run over the real corpus: verdict histogram eyeballed against
  memory of those sessions; flagged turns match where they went sideways.
- `npm run typecheck --workspaces --if-present` and
  `npm test --workspaces --if-present` (core touched), plus the desktop
  workspace commands and a manual `npm run dev` pass: detail card, turn
  links, Struggled filter, Retro view ranking, deep-retro consent flow.
