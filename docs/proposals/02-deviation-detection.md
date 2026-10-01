# 2. Workflow deviation detection in the desktop app

## User story

As a developer reviewing agent runs, I want abnormal runs flagged
automatically (turns that failed too often, ran too long, or skipped expected
workflow steps), so that I know where to look first instead of reading every
session.

**Acceptance criteria**

- With **zero configuration**, sessions get baseline anomaly detection: a turn
  whose tool-failure rate exceeds 50% (over at least 3 interactions) or a
  session exceeding the configured duration limit produces a deviation card on
  the affected turn in the detail Timeline.
- The Timeline heading counts them ("N turn(s) · M workflow divergence(s)");
  core already renders this once deviations are supplied.
- Session list rows show an unobtrusive indicator when a session has
  deviations, and a filter chip shows only flagged sessions.
- If I define workflows in config (`agentObservability.workflows` in
  `~/.agent-observability/desktop/config.json`), sequence and missing-step
  checks run too, with Actual vs Expected sequences on the card;
  content-derived deviations carry the "Local only" badge.
- Deviations never leave the machine.

## Why this matters for research

This is the product's built-in anomaly detector (four deviation types,
evaluated per user-request turn, with a sensible zero-config default), and the
desktop app deliberately stubs it off. Turning it on converts "scroll and
hope" into "start with the flagged runs", and the list-level flag makes
deviation rate a trackable process metric over time.

## Agent spec

**Goal.** Replace the desktop's `noDeviations()` stub with core's real
detector, surface per-turn cards in the detail view, and add a per-session
deviation count to the index for list badges and filtering.

**Grounding: what already exists**

- The stub: `noDeviations()` at
  `src/desktop/agent-observability-desktop/src/datahost/detail/detailRenderer.ts:149`
  (used at lines ~59 and ~73), commented "the desktop app has no workflow
  editor yet". The render path already accepts per-turn deviation arrays.
- Core engine: `LocalDeviationDetector` in
  `src/core/agent-observability-core/src/deviation/localDeviations.ts` (line
  ~37) with `detectForTurns(turns, contentLookup?)`; the detector itself in
  `deviation/deviationDetector.ts`; turn bucketing in
  `deviation/turnGrouping.ts`; the four deviation types in
  `deviation/models.ts`. When no workflow is configured it synthesizes a
  default per repository: empty sequence, timeout and tool-anomaly checks on.
- Card rendering already exists in core's `views/sessionDetailHtml.ts` (around
  lines 1279–1310); cards appear as soon as non-empty deviation arrays are
  passed.
- Config plumbing is free: the desktop's `DesktopSettingsReader`
  (`src/desktop/agent-observability-desktop/src/datahost/drivers/desktopConfig.ts`)
  uses the same key names as the VS Code extension, so core's `Configuration`
  reads `agentObservability.workflows` and `deviation.maxSessionMinutes` from
  `config.json` unchanged. Workflow config schema:
  `schemas/workflow-config.schema.json`; parser:
  `src/core/agent-observability-core/src/config/workflowParsing.ts`.
- Wiring reference: how the VS Code extension produces per-turn deviations
  for the same renderer:
  `src/extension/agent-observability-vscode/src/views/sessionDetailPanel.ts`.
- Content predicates need a `ContentLookup` (attribute to span-value map):
  DB-backed via `getAttributesBySpan` for Copilot
  (`src/core/agent-observability-core/src/telemetry/database.ts`), in-memory
  via `buildUserRequestContent` for Claude
  (`src/core/agent-observability-core/src/claude/mapper.ts`).

**Implementation outline**

1. **Detail path.** In `detailRenderer.ts`, group the session's
   `Interaction`s by user-request turn (core's `turnGrouping`; mirror the
   extension's wiring) and call `LocalDeviationDetector.detectForTurns`,
   passing the source-appropriate `ContentLookup`. If content-lookup plumbing
   proves heavy, ship metadata-only predicates first; content predicates are
   additive.
2. **Index flag.** Add an INTEGER `deviation_count` column to the `sessions`
   table in
   `src/desktop/agent-observability-desktop/src/datahost/indexer/indexDb.ts`,
   bump `SCHEMA_VERSION` (drop-and-rebuild is the migration), extend
   `SessionRow` in `shared/rpc.ts`, and populate it in both indexers
   (`indexer/claudeIndexer.ts`, `indexer/copilotIndexer.ts`) using the
   metadata-only detector path during hydration.
3. **UI.** A small badge on list rows where `deviation_count > 0`; a
   "Deviations" filter chip alongside the source chips in `SourceFilter.tsx` /
   `SessionsView.tsx`; a Settings card exposing the session duration limit
   (numeric input bound to the `deviation.maxSessionMinutes` config key) in
   `views/settings/SettingsView.tsx`.
4. **Changelog + version.** Minor bump; entry written in user terms
   ("Sessions with unusually high tool failure rates or overlong runs are now
   flagged in the list and explained in the timeline").

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these).
Deviations are local-only by design: content-derived ones are barred from
sync by construction; do not add any deviation field to aggregate paths.

**Out of scope.** A workflow editor UI; toast notifications (the extension's
`workflowDivergenceNotifier` pattern); any sync surface.

**Verification**

- Unit tests: an indexer populates `deviation_count` for a fixture session
  with a mostly-failing turn; the detail renderer passes non-empty deviation
  arrays through (assert cards present in rendered HTML; see core's
  `sessionDetailHtml.test.ts` for patterns).
- `npm run typecheck -w agent-observability-desktop`,
  `npm test -w agent-observability-desktop`; if core needed a small export,
  run workspace-wide tests too.
- Manual: open a session known to contain failed tool calls: a deviation
  card appears on the turn; the filter chip shows only flagged sessions;
  setting a tiny `deviation.maxSessionMinutes` in config flags long sessions
  after a refresh.
