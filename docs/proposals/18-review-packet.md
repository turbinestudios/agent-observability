# 18. Review packet

## User story

As a developer about to ask someone to review agent-written changes, I want a
short written account of what the session was asked, what it changed, how it
was checked and where it went wrong, so that the reviewer reads the story
before the diff and I can paste it into the pull request.

**Acceptance criteria**

- **Review packet** in the session header, next to Ask AI, opens a dialog
  with a Markdown preview and **Copy as Markdown**. With sessions ticked in
  the list, the same button on the compare bar builds one packet for up to
  ten sessions.
- The packet covers the goal, the requests (one line per turn), files changed
  with how often each was re-edited, commands by class with failures,
  verification, dead ends, risky actions, sub-agents, models, tokens and
  cost, and the retrospective's findings and tips.
- Paths are repository-relative. A file outside the repository appears by
  name only, marked as outside. No absolute path, branch name, commit name or
  tool output appears.
- **Include what I asked** is on by default. Turning it off removes every
  line of prompt text, including a goal taken from the first prompt and any
  quoted command.
- Anything quoted is cut to one line and scrubbed of token-shaped strings,
  authorization headers and secret-looking assignments; the dialog says how
  many strings were replaced.
- It is built on this machine with no AI. **Ask AI Helper to summarize for a
  reviewer** only opens the AI Helper with a fixed question filled in.

## Why this matters for research

Under heavy agent use, pull requests get larger and review time rises faster
than output. AI reviewers see only the diff. The session transcript holds
what the diff cannot: what was asked, what was tried and abandoned, which
checks ran, which commands were risky. Turning that into a page a human can
read in a minute is the cheapest way to make agent-written changes
reviewable.

## Agent spec

**Goal.** A pure builder and Markdown renderer in core over the session
detail, its retrospective and its activity; one datahost RPC that reuses the
memoized session parse; a dialog with Copy. Static, no vendor call. It also
introduces the redaction helper proposal 19 reuses.

**Grounding**

- `core/text/redact.ts` (new, pure): `redactSecrets(text)` (vendor token
  prefixes, JWTs, `Authorization:` and `Bearer`, secret-named `KEY=VALUE`
  assignments with the key kept, private-key blocks, URL credentials; all
  patterns with bounded quantifiers) and `quoteLine(text, maxChars)`, which
  redacts **then** truncates. `quoteLine` is the only way either builder may
  emit quoted text.
- `SessionActivity` from proposal 16 (`core/analysis/sessionActivity.ts`,
  `getSessionActivity?` on `SessionDataSource`) supplies commands by class,
  file edits, `RISK_RULES` (recursive delete, force push, `--no-verify`, hard
  reset, credential in a command, write outside the repository, package
  install, network call, CI or workflow change, `.env` write, permission
  bypass, `sudo`, pipe to shell) and `rollupFiles`. A source without it (VS
  Code Copilot today) yields a degraded packet with tool names and failures
  only, and says so in one line.
- `core/analysis/reviewPacket.ts` (new, pure; builder and renderer split like
  `analysis/repositoryDigest.ts`): `buildReviewPacket(input): ReviewPacket`
  and `renderReviewPacketMarkdown(packets, { includePrompts })`. Caps as
  exported constants (turn line 140 characters, 40 turns, 30 files, 15
  risks, 20,000 characters per session, 60,000 for several — under GitHub's
  65,536 PR-body limit); lists are trimmed in a fixed order with "and N
  more". Numbers are formatted by hand.
- Dead ends come from retrospective findings that carry a turn index
  (corrections, interruptions, error streaks, repeated prompts) and use the
  finding's own sentence, not prompt text. Verification uses the completion
  check from proposal 16 when present, else test-class command counts
  labelled as not checked.
- **The single parse.** `DetailRenderer`
  (`desk/datahost/detail/detailRenderer.ts`) gains a public
  `sessionFacts(source, sessionId, stamp, context)` returning the memoized
  `{ detail, retro, context, activity }`. Do not call `getSessionDetail`
  directly as the older runners do.
- Datahost `datahost/packet/reviewPacket.ts`: resolves the checkout with
  `improve/repoRoot.ts` `resolveRepoRoot` and maps paths with `promptSafePath`
  (`improve/contextPlan.ts`); an unresolved root reduces paths to file names
  with a note; a session that fails to load is listed as skipped.
- RPC `sessions.reviewPacket(refs: SessionRef[]): { packets, skipped, note? }`.
  The renderer renders the structured packet with core's pure function, so
  the prompt toggle needs no second call.
- Renderer: `views/sessions/packet.ts` (pure), `ReviewPacketDialog.tsx`
  (modelled on `views/workspace/DigestDialog.tsx`, including the clipboard
  fallback), a button in `SessionDetail.tsx` and on `CompareBar.tsx`,
  `packetState` in `selection.ts` (allowed from one session).

**Constraints**

- **Privacy.** Local-only and user-initiated. The packet is built in the
  datahost, shown in the dialog, and leaves the app only through the
  clipboard on an explicit Copy: the same class as the repository digest and
  the Improve-context prompt. Nothing is written to disk and nothing is
  logged. Every quoted string passes `quoteLine`; paths pass the
  `promptSafePath` rule; branch names, commit names, absolute paths and tool
  output never appear. Nothing is added to `aggregate/*`, `sync/*`, `team/*`
  or `schemas/*`. No new exception, and the sanctioned ones are not cited.
- The packet is meant to be pasted into a pull request, so raw content can
  leave the machine by the user's hand. That is why the dialog shows the
  exact text first and offers the no-prompt variant.
- The AI Helper door passes a fixed question and a session reference only.
  The packet text must not be placed in the prefill: the helper's first-use
  notice does not list paths and commands among what it sends.
- Redaction is pattern matching and will miss secrets in prose. Say "secret-
  looking strings were replaced", never "safe to share".

**Out of scope**

- Saving to a file, posting to GitHub, AI-written prose, diff content,
  sub-agent transcripts beyond counts.

**Verification**

- `npm run typecheck --workspaces --if-present`, `npm run lint --workspaces
  --if-present`, `npm test --workspaces --if-present`.
- Tests: one row per redaction rule, idempotence, prose left alone; no
  absolute path in the output for a fixture built with absolute paths; the
  no-prompt variant contains none of the fixture's prompt strings; caps and
  "N more"; the degraded packet; several sessions under the total cap.
- Manual: build a packet for a real session with a planted `ghp_…` token in a
  command; the token is replaced and counted, and the copied Markdown pastes
  cleanly into a pull request description.

## What was settled differently

- **One datahost module.** `datahost/packet/sessionText.ts` holds the packet,
  the brief and the resume-target lookup (`buildReviewPackets`, `buildHandoff`,
  `resumeTarget`, `repoPathFn`) instead of one file each: they share the same
  dependencies and the same path rule.
- **One dialog file.** `views/sessions/SessionTextDialog.tsx` exports both
  `ReviewPacketDialog` and `HandoffDialog`; their pure logic is in
  `views/sessions/packet.ts` (the planned `handoff.ts` was folded into it).
- **Without a known checkout, no file is called "outside the repository".**
  Paths are reduced to their names and the dialog says so, but
  `write-outside-repo` cannot fire on a guess.
- **The source and session id on a packet come from the request**, not from
  the session detail, so a multi-session packet labels each section with the
  ids the list uses.
- **The AI Helper door is offered for a single session only.** The ask intent
  attaches one session; a several-session packet has no door.
- **The prompt toggle is remembered in settings** (`packet.includePrompts`)
  and re-renders locally with no second request.
