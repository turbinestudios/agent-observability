# 19. Hand-off brief and Resume in terminal

## User story

As a developer whose session ran out of context, went wrong, or needs to
continue in another agent, I want a brief I can paste as the first message of
a new session, and one click that opens my terminal on the old one, so that
the next agent starts from where this one stopped and does not relearn my
constraints.

**Acceptance criteria**

- **Hand off** in the session header opens a dialog with a brief and **Copy**.
- The brief is written to the next agent as instructions: the goal; where
  things stand, including how the session ended; my constraints and
  decisions, in my own words; the files in play; what was verified and what
  was not; open items; the context files that were loaded; and a suggested
  first prompt.
- It has no cost section and no tool output. The same redaction, path and cap
  rules as the review packet apply.
- **Resume in terminal** on a Claude Code or Copilot CLI session opens the
  user's own terminal in that session's directory, running
  `claude --resume <id>` or `copilot --resume <id>`, with the brief on the
  clipboard. If the directory is gone or no terminal can be opened, the
  command is copied instead and the app says so.
- Inbox items that ended on an error, an interruption or were abandoned offer
  Hand off directly.

## Why this matters for research

Agents forget everything between sessions, and a session that has compacted
three times has already forgotten its own beginning. The usual fix is to
retype the constraints. The transcript holds them verbatim, alongside what was
verified and what was left open; a brief built from it makes "start a fresh
session" cheap, which is the retrospective's most common advice. It is also
the hand-off the Run view (proposal 15) starts from.

## Agent spec

**Goal.** A pure builder and renderer in core, one RPC over the memoized
session parse, a dialog with Copy, and a terminal launcher in the main
process. Static, no vendor call. This is the only way the app starts Claude
Code: by opening the user's own terminal.

**Grounding**

- `core/analysis/handoffBrief.ts` (new, pure): `buildHandoffBrief(input):
  HandoffBrief` and `renderHandoffBriefMarkdown(brief)`; `deriveEnding`
  (`turn-complete | waiting | interrupted | error | tool-pending | unknown`),
  `extractConstraints`, `extractOpenItems`. Caps as exported constants (8
  constraints of 400 characters, 20 files, 8 open items, 12 context files,
  8,000 characters in total).
- Constraints are sentences from the user's own prompts matching
  `CONSTRAINT_MARKERS` (must, never, do not, always, only, without, instead
  of, keep, avoid, make sure), plus correction prompts (`isCorrectionPrompt`
  from `analysis/retrospective.ts`): verbatim, through `quoteLine`, capped,
  de-duplicated, newest last, each with its turn number.
- Open items come from marker lines in the last turn's final response only
  ("from the last reply"), plus "the last check failed" by command class and
  "the last request was interrupted". The builder never reads tool results.
- Files come from `SessionActivity` (proposal 16), ordered by last-touched
  turn; verified and not verified from the completion check when present;
  context files from the cached `SessionContextAnalysis`, made repository-
  relative.
- Reuses `core/text/redact.ts` and `DetailRenderer.sessionFacts()` from
  proposal 18. If this ships first, that foundation moves with it.
- RPC `sessions.handoffBrief(source, sessionId): { brief, note? }` and
  `sessions.handoff(source, sessionId): { cwd?, sessionId, cli: 'claude' |
  'copilot', brief, problem? }`. The cwd is re-read from the head of the
  transcript (`main_path`) and checked to exist; no index column, no schema
  change.
- Main process: `main/terminalLaunch.ts` (pure; returns `{ file, args,
  options }[]` in try order, spawned detached with `shell: false`) and an
  `app:open-terminal` handler. Windows: `wt.exe -d <cwd> cmd /k …`, then
  `cmd.exe /c start`. macOS: `osascript` telling Terminal to run the command.
  Linux: `x-terminal-emulator`, `gnome-terminal`, `konsole`. Fallback: copy
  the command and open the folder. A setting `run.terminalCommand` (template
  with `{cwd}` and `{command}`) overrides the built-in launchers.
- Renderer: `views/sessions/handoff.ts` (pure), `HandoffDialog.tsx`, Hand off
  and Resume in terminal buttons in `SessionDetail.tsx`, a Hand off action on
  the matching inbox items (proposal 17).

**Constraints**

- **Privacy.** Local-only, user-initiated, clipboard-only, exactly as the
  review packet: nothing written to disk or logged, every quoted string
  through `quoteLine`, repository-relative paths, no branch or commit names,
  no tool output, nothing on `aggregate/*`, `sync/*`, `team/*` or `schemas/*`.
  The brief quotes the user's own prompts; the dialog shows the exact text
  before Copy.
- **Main builds the command itself.** It accepts `{ cwd, cli, sessionId }`,
  validates the id against a UUID pattern and the cwd as an existing absolute
  directory, and never accepts a command string from the renderer.
- **Claude Code is never driven.** The app does not spawn `claude` to run a
  session and does not use the Claude Agent SDK; it only opens the user's
  terminal with their own signed-in `claude`.
- The brief must not be written into a repository file. The one sanctioned
  write path is proposal 11's and is not cited here.
- A constraint the user later reversed is still quoted; turn numbers and
  newest-last order are the mitigation. Open items are the assistant's own
  claims and are labelled as such.

**Out of scope**

- Launching or hosting a session (proposal 15), AI summarisation, briefs over
  several sessions, an embedded terminal.

**Verification**

- `npm run typecheck --workspaces --if-present`, `npm run lint --workspaces
  --if-present`, `npm test --workspaces --if-present`.
- Tests: the `deriveEnding` truth table; constraint extraction and caps;
  open-item markers; no absolute path, cost or token figure in the output;
  the total cap; `terminalLaunch` argv per platform with the platform
  injected, an invalid id rejected, a cwd containing spaces and quotes, the
  override template.
- Manual: Hand off on a session that ended on a failed test lists that check
  as not verified and quotes the constraints you gave. Resume in terminal
  opens a terminal in the session's directory with the resume command
  running; rename the directory and it falls back to copying the command.

## What was settled differently

- **The working directory is read through a small index accessor.**
  `IndexDb.mainPath(source, sessionId)` returns the session's own file; the
  resume target then reads `cwd` from the head of a Claude transcript (first
  256 KiB) or from the Copilot CLI session's `workspace.yaml`. No index
  column was added and the path never reaches the renderer.
- **Main validates and builds everything.** `main/terminalLaunch.ts`
  (`validateResumeRequest`, `terminalLaunches`, `openTerminal`) accepts only
  `{ cwd, cli, sessionId }`: the CLI is one of two literals, the id a UUID,
  the folder an existing absolute directory with no control characters. On
  Linux `x-terminal-emulator` takes its folder from the process working
  directory; the other two launchers take it as an argument.
- **Resume in terminal lives in the Hand off dialog**, not as a separate
  header button: it copies the brief first, then opens the terminal, and
  shows the command to paste when no terminal could be started.
- **`run.terminalCommand`** (a user-supplied launcher template) is not
  implemented; the built-in launchers and the copy fallback cover v1.
- **A source without activity gets a degraded brief.** Files and commands are
  absent and the brief says what could not be seen, instead of implying
  nothing happened.
