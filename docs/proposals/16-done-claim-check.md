# 16. "Did it really finish?"

## User story

As a developer who delegates work to an agent, I want each session to show
what was and was not observed about its completion, so that I know which
"done" reports to check before trusting them.

**Acceptance criteria**

- Each analysed session that edited code carries one status: **Verified**,
  **Not verified**, **Check failed** or **Left unfinished**. The chip is absent
  when the check does not apply or the session is not analysed yet; absence
  never reads as verified.
- Session detail shows a completion card above the retrospective card,
  listing each check with a fixed sentence and a link to the evidence turn.
- Sessions can be filtered by status and by "reported done". The Dashboard
  shows **Reported done, not verified** (count and share of the sessions that
  changed code in the window) and drills into Sessions. Evidence has a
  Completion tab.
- The retrospective lists the matching finding and tip.
- Every sentence says what was "observed" or "not observed". The app never
  judges intent, and the card footer states the limits: checks run in CI,
  another terminal or a hook are not visible here.
- No command text, message text or path is stored or leaves the machine.

## Why this matters for research

"Almost right, but not quite" is the most-cited frustration with coding
agents, and review time rises with agent use because every "done" has to be
re-checked by hand. The transcript already says whether a test, build, lint or
type-check ran after the last edit and whether it passed. No runner shows
that, because none of them keep the history; this app does.

## Agent spec

**Goal.** A per-session completion check derived locally and heuristically
(no AI) from what the transcript recorded, persisted as enums and counts,
surfaced as a chip, a card, a filter, a Dashboard card and a retrospective
input. It introduces the one module that reads command and edit inputs,
which proposals 8, 18 and 19 reuse.

**Grounding**

- **The single raw-content chokepoint** (new, introduced here):
  - `core/analysis/sessionActivity.ts` (pure): `SessionActivity { commands:
    { turnIndex, class, failed, resultMasked, text }[]; edits: { turnIndex,
    path, linesAdded, linesRemoved, created }[]; permissionModes; subAgents;
    complete }`, `classifyCommand`, `COMMAND_CLASS_RULES` (classes `test |
    build | lint | typecheck | install | git | run | network | filesystem |
    other`), `RISK_RULES`, `rollupFiles`.
  - `core/claude/activitySignals.ts`: `extractSessionActivity(records)`, the
    sibling of `retrospectiveSignals.ts`. Shell tools: `input.command`,
    `run_in_background`, and the matching `tool_result.is_error`. Edit tools
    (`Edit`, `Write`, `MultiEdit`, `NotebookEdit`): `input.file_path` and line
    counts from `structuredPatch`. Tool result bodies are never read.
  - `getSessionActivity?(sessionKey, detail?)` on `SessionDataSource`
    (`core/sources/sessionSource.ts`). Claude implements it over the same
    mtime-keyed `fileCache` `getSessionRetrospective` already uses
    (`claudeCodeService.ts:270`), so nothing is read twice.
- `core/analysis/completionCheck.ts` (pure): `CompletionStatus = 'verified' |
  'unverified' | 'contradicted' | 'incomplete' | 'not-applicable'`,
  `CompletionClaim = 'done' | 'partial' | 'none'`, `CompletionEvidence`
  (counts, enums, booleans and turn indices only), `classifyClosingText`,
  `decideCompletion(evidence): CompletionCheck { status, naReason?, claim,
  checks: { id, passed, evidenceTurnIndex?, detail }[] }`.
- A command's result is **masked** when its exit status cannot be trusted: a
  pipe after it (`| tail`, `| head`, `| grep`), `|| true`, `; echo`, or a
  background run. A masked run counts as "ran, result not observed".
- Closing text is classified from phrase tables in the style of the
  correction tables in `analysis/retrospective.ts`; a partial marker ("could
  not", "still failing", "skipped", "todo") wins over a done marker.
- **Decision table** (first match wins):

  | Condition | Status |
  | --- | --- |
  | No code-edit calls | not-applicable (`no-edits` or `docs-only`) |
  | The source cannot see commands | not-applicable (`source-lacks-evidence`) |
  | Claim is done, last check failed with a known result, nothing after it | contradicted ("Check failed") |
  | Claim is partial, or ended on a failed tool, or last check failed with no claim | incomplete ("Left unfinished") |
  | No check after the last edit, or its result was masked | unverified ("Not verified") |
  | A check after the last edit with an observed pass | verified |

- Wiring: `RetrospectiveSignals` gains optional completion evidence;
  `buildSessionRetrospective` calls `decideCompletion` and sets
  `SessionRetrospective.completion`. The analyzer
  (`desk/datahost/analysis/sessionAnalyzer.ts`) and the detail renderer both
  go through the retrospective, so the chip and the card cannot disagree.
- Persisted in `session_analysis` columns added by proposal 7's schema v6
  (`completion_status`, `completion_claim`, `verify_runs`, `verify_failures`,
  `last_verify_class`, `verified_after_last_edit`, `last_verify_failed`,
  `ended_on_failed_tool`). This release bumps `analysis_version` only.
- Findings appended to `RetrospectiveSignalId` (never rename an existing id):
  `completion-unverified`, `completion-contradicted`, `incomplete-ending`.
  Advice rules `ask-for-verification` and `fix-failing-check-first`.
- Card: `renderCompletionCard` in `core/views/sessionDetailHtml.ts`, called
  just before the retrospective card and reusing its turn-link markup.
- RPC: `evidence.completion`, `SessionRow.completion` / `claimedDone`,
  `ListSessionsParams.completion` / `claimedDone`, an `OverviewInsights`
  evidence block.

**Per-source support**

| Source | What is possible |
| --- | --- |
| Claude Code | Everything above. |
| Copilot in VS Code (OTel) | Tool names and span status only. A terminal tool's status reflects the tool call, not the command's exit code, so pass/fail is not observable. v1: `not-applicable`, no chip. |
| Copilot CLI (proposal 14) | Parity through the same `SessionActivity` (`tool.execution_start` arguments and `tool.execution_complete.success`). |

**Constraints**

- **Privacy.** Command text, final-message text and the OUTPUT of
  verification commands are raw content. They are read in memory inside the
  chokepoint to classify them: the command into a class, the closing text
  into a claim, and, for test, build, lint and type-check commands only, the
  tail of what the command printed into `passed | failed | unknown`. Only the
  class enum, that three-valued outcome, counts, booleans and turn indices
  leave the chokepoint, and nothing else is persisted or returned. No other
  command's output is read. `detail` strings come from a fixed table and are
  never interpolated with content. Completion data never enters
  `aggregate/*`, `sync/*`, `team/*` or `schemas/*`.
- **The verdict moves at most to `bumpy`.** The verdict mix reaches team
  shards, so a new rule must not shift shared numbers hard:
  `completion-contradicted` adds a `bumpy` reason only; contradicted and
  incomplete cap the local-only `outcome` at `partially`; unverified leaves
  the outcome alone.
- Wording: "observed" and "not observed". Never "the agent lied".
- Keep `NULL` (not checked) distinct from `not-applicable`, and persist the
  denominators, so a later local ROI view can compute honest rates.

**Known false positives (state them in the UI help)**

- Checks run by the user, CI or a hook; edits made through the shell (`sed`,
  heredocs) or MCP tools; wrapper scripts the command table does not know;
  masked exit codes; closing phrasing the tables miss (lands in the softer
  bucket); sessions continued in another transcript; a check run for a
  different package in a monorepo. Writes outside the repository are info
  only and never move the status.

**Out of scope**

- Any git call (uncommitted-work hints); AI judgement of the diff; running the
  checks; completion status in the team shard.

**Verification**

- `npm run typecheck --workspaces --if-present`, `npm run lint --workspaces
  --if-present`, `npm test --workspaces --if-present`.
- Table-driven tests for the command classes (compound and masked forms), the
  closing phrases, every decision-table row, and a detail-sentence test
  asserting no fixture text appears in any output.
- Manual: a Claude Code session that edited code and then ran a passing test
  reads Verified; the same without the test run reads Not verified; one whose
  last test failed while the reply says "done" reads Check failed.

## What was settled differently

- **The projection rides inside the retrospective counts.** `RetrospectiveCounts`
  gained an optional `completion` block (`CompletionCounts`), so the analyzer's
  `SessionAnalysis` did not change shape: `putAnalysis` reads
  `analysis.retro.completion` and writes the `session_analysis` columns from it.
- **The service always loads sub-agent transcripts for the retrospective**, so a
  check a sub-agent ran counts as a check. The files are memoized by path and
  modification time; nothing is read twice.
- **Inside-the-repository is a path test, not a git call.** The checkout root is
  found by climbing from the session's working directory to a `.git` entry and
  cached per directory; without one the working directory is the boundary.
- **A source without evidence carries no completion at all** rather than a stored
  `not-applicable` row: VS Code Copilot sessions simply have no chip and no card.
  `not-applicable` is stored only for Claude Code sessions that changed no code
  or only documentation.
- **Session rows and the renderer use four statuses.** `not-applicable` and
  "not checked" both read as absent on a row; the list shows a chip only for
  Check failed, Left unfinished, and Not verified when the last reply reported
  the work as done. Verified rows stay quiet, like smooth verdicts; the detail
  card states every status.
- **One drill-down, several statuses.** `ListSessionsParams.completionIn` was
  added beside `completion` so "Reported done, not verified" (unverified or
  contradicted, with a done claim) is one query.
- **The pure tab helpers live in `views/retro/completionCounts.ts`**, not
  `completionTab.ts`: a file differing from `CompletionTab.tsx` only in case
  breaks module resolution on case-insensitive file systems.
- **`ANALYSIS_VERSION` is 2.** Existing sessions are re-analysed once on first
  launch; the index is not rebuilt.
- **Turn anchoring was verified** against the mapper's own rule
  (`isUserRequest`): the activity chokepoint uses the identical predicate, so
  evidence turn links land on the turn the detail view shows.

- **A check's result is read from what it printed, not only from its exit
  status (calibration, 2026-10-06).** The first cut treated any piped check
  (`npm test 2>&1 | tail -30`, `tsc --noEmit | grep "error TS"`) as "ran,
  result not observed". On this machine's 40 most recent sessions that made
  Verified unreachable: of 17 sessions that changed code, 12 read Not
  verified, 5 Left unfinished, none Verified. The counts behind it (counts
  only; no command, output or path was printed):

  | Verification commands seen | 333 |
  | --- | --- |
  | Exit status trustworthy (not masked, not background) | 2 |
  | Started in the background | 21 |
  | Masked | 310 |
  | of those: piped to a truncating stage (`tail`, `head`, `tee`, `cat`) | 116 |
  | of those: piped to a filtering stage (`grep`, `findstr`, `Select-String`...) | 174 |
  | of those: followed by `;`, `||` or another pipe | 20 |

  So `core/analysis/verificationOutput.ts` (`classifyVerificationOutput`,
  table `VERIFICATION_OUTPUT_RULES`) now classifies the tail of a
  verification command's output by tool family (vitest, jest, pytest, go,
  cargo, dotnet, Maven/Gradle, TypeScript, ESLint, mypy/pyright/ruff, common
  bundlers, npm/make failures), and `ActivityCommand` carries
  `outcome: passed | failed | unknown` plus `maskedBy`
  (`truncate | filter | pipe | or | sequence`). Read it with
  `commandOutcome()`. The rules:
  - A failure marker from ANY family decides `failed`, whatever the class (a
    `test` script that type-checks first can fail on an `error TS` line), and
    it also overrides a clean exit status.
  - `passed` needs a POSITIVE pass marker from a family that fits the class.
    Markers are anchored to summary lines, so a test named "handles failed
    logins" cannot flip a run.
  - Absence of failure markers is a pass in exactly two cases: an unmasked
    command whose tool call did not error (the exit status), and a type-check
    or lint behind a truncating pipe that printed nothing of its own. The
    second covers the commonest shape, `npm run typecheck 2>&1 | tail -20`
    printing only the script banner; script banners count as silence only
    when fewer lines arrived than the pipe lets through, because `tail -3`
    over several workspaces could have cut an earlier one's errors.
  - A filtering pipe that prints nothing stays `unknown`: a `grep` for errors
    that finds none proves nothing about the run.

  Resolution of the 310 masked commands after the change: 121 passed, 93
  failed, 96 unknown. Session statuses on the same 40 sessions: 4 Verified,
  8 Not verified, 5 Left unfinished, none Check failed (before: 0 / 12 / 5 /
  0). Of the 8 still Not verified, 6 had no check at all after the last code
  edit, which is what the status is for, and 2 had a check whose output
  carried no recognisable summary.
- **`ANALYSIS_VERSION` moved on with the calibration**, so existing sessions
  are re-analysed once more; the index is not rebuilt. The "unknown result"
  sentence now reads "A check ran after the last edit; its result could not
  be read from what the session recorded."
