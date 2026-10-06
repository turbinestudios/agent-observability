# 17. Attention inbox

## User story

As a developer with several agent sessions open, I want one list of what needs
me now and what finished while I was away, most worrying first, so that I stop
cycling through terminals to find the session blocked on me.

**Acceptance criteria**

- The Workspace view opens with a **Needs you** section above Now. It lists
  sessions waiting for input, sessions with a tool call pending long enough
  that it may be waiting for approval, and sessions that finished or ended
  badly since the inbox was last cleared.
- A waiting session stays listed until the agent resumes or the item is
  dismissed, including after its live card has gone idle.
- Finished sessions are ordered: completion check failed, ended on an error,
  not verified or left unfinished, struggled or abandoned, ended on an
  interruption, unusually expensive, then the rest.
- Each item can be opened, dismissed, or snoozed for 15 minutes, 1 hour or
  4 hours. A dismissed item returns only if the session needs the user again.
- The Workspace rail entry shows a count of new items, in the collapsed and
  the expanded rail.
- The state survives restarts and index rebuilds. Nothing is installed into
  either agent, and "may be waiting for approval" is labelled as a guess.
- With Workspace notifications on, a toast also fires for a probable approval
  prompt and for a session that ended on an error.

## Why this matters for research

Knowing when an agent needs you is the problem every orchestrator keeps
rebuilding as an inbox, each for one vendor or one terminal multiplexer. The
live board answers "what is running"; it forgets a session the moment it goes
idle, and it cannot rank what finished. An inbox ranked by the app's own
judgement (did the check fail, did it struggle, did it cost three times the
usual) is the part only an observer with history can build.

## Agent spec

**Goal.** A pure ranking and state machine in core, a small JSON-backed
service in the datahost fed by the live board and the index, a section in
Workspace and a badge on the rail. No index schema change.

**Grounding**

- `core/inbox/attention.ts` (new, pure, no node imports): reasons
  `permission | permission-likely | waiting | finished | ended-error |
  ended-interrupted`; states `new | seen | dismissed | snoozed`; flags
  `contradicted | unverified | incomplete | struggled | abandoned |
  cost-outlier`; `liveCandidates`, `finishedCandidates`, `attentionTier`,
  `compareAttention`, `reconcile(stored, candidates, now)`, `unreadCount`.
- **Candidates key off `lastEvent`, not `status`.** `deriveLiveStatus`
  (`core/live/liveStatus.ts`) turns a waiting session `idle` after three
  minutes; the inbox must keep it. `waiting`: last event is `assistant-text`,
  `turn-ended` or `interruption`. `permission-likely`: last event is
  `tool-pending`, no pending tool is a sub-agent call (`Task`, `Agent`), and
  the wait exceeds `PENDING_TOOL_HINT_MS` (a longer threshold for shell
  tools). `permission`: an exact signal, set only by proposal 15.
- Tiers, lowest first: exact permission; probable approval; waiting; finished
  with a contradicted check; ended on an error; unverified or incomplete;
  struggled or abandoned; ended on an interruption; cost outlier (at least
  three times the repository median over at least ten sessions); the rest.
  Live tiers sort oldest first (blocked longest), finished tiers newest
  first, then by key.
- `reconcile`: no record → `new`; a newer episode resets a dismissed or seen
  item to `new`; an expired snooze → `new`; a live-reason record with no
  candidate is deleted; finished records are pruned after seven days.
- `core/live/liveStatus.ts` gains `lastToolFailed` on `LiveTailFacts`, passed
  through to `LiveSessionRow` (not part of the board's emit fingerprint).
- Datahost: `datahost/inbox/inboxStore.ts` (`inbox.json` beside
  `renames.json`, temp file then rename, malformed entries dropped) and
  `inboxService.ts`. The service remembers each session's terminal event
  while the tail is still read, because the board stops reading tails after
  30 minutes and reports `unknown`. Finished rows come from
  `db.listSessions({ endedAfterMs })`; the repository median is computed from
  the same rows in JS. `createdAtMs` in the store is the floor, so the first
  run does not surface a week of history.
- RPC: `inbox.list({ includeDismissed? })`, `inbox.mark(keys | 'all', 'seen' |
  'dismissed' | 'snoozed' | 'new', { untilMs? })`, event `inbox.changed`.
- Renderer: `views/workspace/inbox.ts` (pure: labels, grouping into "Needs
  you now" and "Since you last looked", fixed-duration snooze,
  `inboxNotifications`), `useInbox.ts` hoisted into `App.tsx` beside
  `useLiveNotifications`, `InboxSection.tsx` first in `WorkspaceView.tsx`.
  `ActivityRail.tsx` gains `badges?: Partial<Record<ViewId, number>>`;
  `components/railBadge.ts` (pure) caps the text at `9+`.
- Completion flags come from proposal 16 when present; without it the inbox
  ranks on verdict, ending and cost alone.

**Constraints**

- **Privacy.** Local-only; no vendor call, no network, nothing added to
  `aggregate/*`, `sync/*`, `team/*` or `schemas/*`. `inbox.json` holds session
  keys, reason and state enums and timestamps only; never a title, path,
  branch or transcript text. Titles and repositories are joined at read time
  from the index. Notifications show what the live-board notification
  already shows. Does not cite the sanctioned exceptions as precedent.
- Hook-free, like the live board: a long test run can read as an approval
  prompt. The longer shell threshold, the excluded tools, the "may be"
  wording and the lower tier are the mitigation; say so in the view.
- "Finished" lags by the board's 30 minutes, because a closed terminal is not
  observable without hooks.
- No new setting: notifications reuse `workspace.notifications`.

**Out of scope**

- Copilot rows for the waiting, approval and ending reasons until proposals
  14 and 15 land (finished works for both sources today).
- A tray or dock badge; answering a prompt from the app; a separate rail
  view; a settings UI for thresholds.

**Verification**

- `npm run typecheck --workspaces --if-present`, `npm run lint --workspaces
  --if-present`, `npm test --workspaces --if-present`.
- Table-driven core tests with numeric timestamps from a fixed `now`: tiers,
  a waiting session past the idle threshold stays a candidate, a pending
  `Task` is never a probable approval, episode reset, snooze expiry, pruning,
  the cost-outlier sample floor, deterministic ties. Service tests with fake
  timers and a temp store.
- Manual: leave a Claude Code session waiting for more than three minutes; it
  stays under Needs you with a rail count. Dismiss it, prompt the session,
  let it wait again: the item returns.

## What was settled differently

- **The store also remembers how sessions ended.** `inbox.json` carries a
  `terminals` map beside `items` (`source:sessionId` to the last readable
  event, whether its tool failed, and when). The spec kept that in memory;
  persisting it means a session that ended on an error while the app was
  closed, or before a restart, still reads "ended on a failed tool call". It
  is still enums, booleans and timestamps only.
- **The service rechecks on a timer while anything is live** (every 30
  seconds). A tool call becomes a probable approval prompt by staying quiet,
  which is exactly when the live board has no change to announce, so its
  events alone would never surface the item.
- **A known permission request has no age limit.** Copilot CLI and
  SDK-hosted sessions persist their permission requests, so an unanswered
  one stays in the inbox as an exact "Waiting for your approval" for as long
  as the board lists the session, not only for half an hour.
- **Hiding a session removes it from the inbox immediately**, without waiting
  for the next index pass.
- **Completion status is read when present.** The inbox ranks by the
  completion check as soon as proposal 16's `SessionRow.completion` exists
  and falls back to verdict and cost until then; no contract change either way.
- The rail badge's accessible name is built by `railBadgeLabel` beside
  `railBadgeText`, so the collapsed strip's tooltip says "Workspace, 3 new"
  too.
