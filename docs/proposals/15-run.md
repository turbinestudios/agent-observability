# 15. Run: host Copilot sessions in the app

## User story

As a developer reviewing what my agents did, I want to start or continue a
Copilot session from the app, with the goal prefilled from what the app
already knows, and approve each action as it comes, so that acting on a
finding does not mean retyping it in a terminal.

**Acceptance criteria**

- Run is off until turned on in Settings. The first time the view opens, a
  notice states what a session sends and to whom; nothing can start before it
  is acknowledged.
- The Run view has an editable goal box, a repository picker limited to
  checkouts the index knows and can verify on disk, a model picker, and Start.
- **Doors only fill the goal box and the repository; nothing is sent until
  Start.** The doors: "Continue this session" on a Copilot CLI session,
  "Start a session with this digest" on a repository hub, "Apply this plan
  with an agent" from Improve, "Retry with the retrospective's advice" from
  Retro, and the hand-off brief from proposal 19.
- The transcript streams, with tool rows showing name, target and result.
- A permission request shows a card with the exact command or file and three
  answers: **Allow once**, **Allow for this session**, **Deny**. The session
  waits until answered. No setting makes the app approve everything (see
  "What was settled differently" for the per-session Allow all).
- Stop aborts the current turn; a follow-up continues the session. A hosted
  session can be resumed from the terminal with `copilot --resume`, and a CLI
  session can be continued in the app.
- A hosted session is on the live board with exact status, including
  **Waiting for your approval**, and is one Copilot CLI session in the index,
  counted once.
- If the installed `copilot` is missing, too old or not signed in, the view
  says so with the fix. The app ships no Copilot runtime.
- Quitting the app with a session running asks first; the session stays
  resumable.

## Why this matters for research

The product already observes, judges and proposes improvements; it stops one
step short of acting on them. Runners have the opposite gap: they start
sessions and forget them. A thin Run closes the loop — the retrospective's
advice, a repository's digest or an improvement plan becomes the first prompt
of the next session, and that session's outcome is judged in turn — without
turning the app into another terminal multiplexer.

## Agent spec

**Goal.** Host GitHub Copilot sessions in the datahost through the Copilot
SDK, driving the user's own installed `copilot`, with in-app permission
prompts and exact live status. The hosted session lands in the index only
through proposal 14's source. Ships with a display-only rename.

**Grounding**

- SDK (`@github/copilot-sdk`, MIT, GA 2026-06-02, ESM-only): `CopilotClient`
  with `RuntimeConnection.forStdio({ path, args, env })`; `createSession({
  sessionId, model, workingDirectory, onPermissionRequest,
  onUserInputRequest, … })`; `resumeSession(id)`; `session.send | abort |
  disconnect | setModel | on`; events for messages, deltas, tool execution,
  usage, compaction and sub-agents. Sessions persist under
  `~/.copilot/session-state/{id}/` and resume from the CLI and back.
- Permission request `{ kind: 'shell' | 'write' | 'read' | 'mcp' |
  'custom-tool' | 'url' | 'memory' | 'hook', toolCallId, toolName?, fileName?,
  fullCommandText? }`; results `approve-once`, `approve-for-session`,
  `reject`, `user-not-available` (and persistent kinds the app never sends).
- Desktop datahost, new `datahost/run/`:
  - `runDriver.ts`: the interface (`start`, `resume`, `send`, `abort`,
    `close`, `listModels`, `probe`) and a driver-neutral event type.
  - `sdkDriver.ts`: the only file that imports the SDK, through a dynamic
    `import()` (the datahost bundle is CommonJS).
  - `runtimePath.ts`: resolves the launch target from
    `aiHelper.copilotCliPath` and the existing candidates logic; an npm
    `.cmd` shim is resolved to the package's JS entry and launched with
    `process.execPath` and `ELECTRON_RUN_AS_NODE=1`, never through a shell.
    Environment passes `sanitizeCopilotEnv`.
  - `runController.ts`: session map, a status machine over driver events
    (`starting | working | waiting-approval | waiting-input | idle | stopped |
    error`), parked permission promises, deltas coalesced and host-rendered
    with the AI Helper's markdown path (`datahost/aiHelper.ts`).
  - `runPrefill.ts` (pure, capped builders over the digest, plan, retro and
    brief), `runs.ts` (JSON store of sessions started here).
- The host runs **inside the datahost** behind `RunDriver`: the index pass is
  already off-thread, the live board reads exact status with no second hop,
  and sessions persist on disk, so a datahost crash loses nothing but the
  connection.
- The app generates the session id and passes it to `createSession`. The run
  host writes no index rows; the session reaches the index through proposal
  14's indexer, so it is counted once. `LiveBoardService` takes a `hosted`
  provider whose state overrides the disk-inferred row and sets `exact`.
- RPC: `run.availability`, `run.acknowledge`, `run.repositories`,
  `run.start`, `run.resume`, `run.send`, `run.abort`, `run.close`, `run.list`,
  `run.transcript`, `run.permission.respond`, `run.input.respond`,
  `run.prefill`; event `run.event` (status, item upsert, permission,
  permission-cleared, input, usage). Every `run.*` method except
  availability and acknowledge refuses unless Run is on and acknowledged.
- Renderer `views/run/`: `RunView`, `GoalBox`, `Transcript`, `ToolRow`,
  `PermissionCard`, `RunNotice`, and a pure `runReducer.ts`. A Run rail entry,
  hidden while disabled. A `RunIntent` in `App.tsx` beside the other intents.
- Settings: `run.enabled` (off), `run.defaultModel`, acknowledgement key
  `run.disclosed`. No permission-default setting: the posture is a constant.
- **Claude Code hand-off** is "Resume in terminal" from proposal 19; Run
  never drives Claude.

**Constraints**

- **Licensing: drive the installed CLI; ship no runtime.** The SDK is MIT, but
  the Copilot CLI it can bundle may be redistributed only unmodified inside an
  app with material functionality of its own. Exclude
  `node_modules/@github/copilot-sdk-*/**` in `electron-builder.yml`, and
  assert in `packaging.test.ts` that the SDK is present and no runtime
  package is. If the spike shows the SDK cannot start without its bundled
  runtime, stop and ask the owner: that is a licensing decision.
- **Ask is the only permission posture.** Allow once → `approve-once`; allow
  for this session → `approve-for-session`; deny → `reject`. Never
  `approve-permanently` or `approve-for-location` (they persist into the
  user's Copilot config). `approveAll` is never imported; a source-scan test
  over `datahost/run` enforces it. App quit or abort resolves pending requests
  as `user-not-available`.
- No SDK code in core: the extension bundles core.
- The repository picker offers only roots verified by
  `datahost/improve/repoRoot.ts` `resolveRepoRoot`; no free-text path.
- **Privacy: the following clause requires owner sign-off before it is added
  to `AGENTS.md`.** It is a separate clause, not a fourth sanctioned
  exception: the exceptions cover payloads the app composes for an analysis
  feature, whereas here the app relays what the user typed to an agent the
  user is operating.

  > - **The app as agent host (Run).** When the user turns Run on in Settings
  >   (off by default) and has acknowledged a one-time notice in the view, the
  >   desktop app can start and continue GitHub Copilot sessions through the
  >   Copilot SDK, driving the user's **own installed, unmodified `copilot`**
  >   under their **own Copilot login**; never a product API key, never a
  >   bundled runtime. A hosted session sends the user's message, and whatever
  >   repository content the agent then reads, to GitHub, exactly as running
  >   `copilot` in that directory does. The rules:
  >   1. **User-initiated per message.** Nothing is sent until the user
  >      presses Start or Send. Doors from other views only prefill an
  >      editable goal box; the text in the box is exactly what is sent.
  >   2. **Ask is the only permission posture.** Every permission request is
  >      shown to the user and waits for their answer: allow once, allow for
  >      this session, or deny. The app never answers on the user's behalf,
  >      never passes `--allow-all` or an equivalent, never persists an
  >      approval beyond the session, and strips permission-widening
  >      environment variables.
  >   3. **Never in the background.** No scheduled, automatic or hidden
  >      session; none starts at launch; closing the app stops hosting.
  >   4. **Separate from sharing.** Nothing from a hosted session enters the
  >      aggregate, sync or team paths other than the counts every indexed
  >      session contributes. The run host has no import from `aggregate/*`,
  >      `sync/*` or `team/*`.
  >   5. **Claude Code is never driven.** The app only opens the user's own
  >      terminal with their own `claude --resume <id>`; it does not use the
  >      Claude Agent SDK and does not spawn `claude` to run a session.
  >
  >   This clause is not one of the sanctioned exceptions and none of them may
  >   be cited to widen it.

  The write-path bullet's last sentence becomes: "No other **app** code may
  write into a user's repository. An agent the user hosts through Run writes
  only through the Copilot CLI's own tools, each write approved by the user
  under the clause above." `docs/privacy-validation.md` and this folder's
  ground rule 1 follow in the same change.

**Verified by the SDK spike (2026-10-06)**

Run on Windows against an npm install of the Copilot CLI (`copilot --version`
1.0.90-0, runtime 1.0.82, protocol 3) with `@github/copilot-sdk` 1.0.16, in a
temporary working directory, through the owner's own Copilot login.

- **A `.cmd` shim cannot be launched.** `RuntimeConnection.forStdio({ path:
  'copilot.cmd' })` fails with `spawn EINVAL`. Passing the package's JavaScript
  entry (the `bin` of the installed `@github/copilot` package, `npm-loader.js`)
  works: for a path ending in `.js` the SDK itself spawns
  `process.execPath [entry, --headless, --no-auto-update, --stdio]`. Inside
  Electron `process.execPath` is the app binary, so the connection's `env`
  must carry `ELECTRON_RUN_AS_NODE=1`. `runtimePath.ts` therefore resolves a
  native executable as-is and an npm shim to its JS entry; it never uses a
  shell.
- **The SDK starts without its bundled runtime.** With the
  `@github/copilot-sdk-<platform>` package removed and a path supplied, the
  client starts, reports status, the signed-in user and the model list. The
  app ships no runtime; the licence question does not arise.
- **The package has a CommonJS build** (`require` export) beside the ESM one,
  so the datahost can load it either way. Its `koffi` dependency is only used
  by the experimental in-process connection, which this proposal does not use.
- **SDK sessions are ordinary Copilot CLI sessions on disk**:
  `~/.copilot/session-state/<id>/` with `events.jsonl`, `workspace.yaml`
  (`client_name: sdk`), `checkpoints/`, `files/`. Proposal 14's source indexes
  them unchanged.
- **Instruction files apply.** An `AGENTS.md` in the working directory was
  loaded into the system message and obeyed, in the default mode.
- **Permission requests are complete and are also persisted.** The handler
  receives `{ kind: 'write', toolCallId, intention, fileName, diff }` (shell
  requests carry the command text); returning `{ kind: 'reject', feedback }`
  left the file uncreated and the agent reported the denial. `events.jsonl`
  records `permission.requested` and `permission.completed`, so the live board
  can show an exact "waiting for approval" for observed sessions too.
- **Usage is available live.** `assistant.usage` carries token details and
  `copilotUsage.totalNanoAiu`; `session.usage_checkpoint` and
  `session.shutdown` carry the totals on disk.
- `client.deleteSession(id)` removes a session's directory. The app never
  calls it in this proposal (it only reads under `~/.copilot`).

Still to confirm while building: the current names of the streaming, MCP and
custom-agent session options, and the same launch path on macOS and Linux.

**Rename (display only, ships in this release)**

- Change to `<NewName>`: the window title (`desk/main/index.ts`), the
  renderer `<title>`, rail and branding copy, the extension `displayName` and
  activity-bar title, the `@obs` `fullName`, READMEs and docs prose, and a
  `### Changed` line in both changelogs.
- **Do not change:** `appId`, `productName` (it sets the `userData` path; if
  it must change, pin `userData` to the old path and test an in-place upgrade
  on Windows and macOS first), the update feed and `desktop-v*` tags,
  `~/.agent-observability/**`, the `agentObservability.*` setting, command
  and view ids, the extension `publisher` and `name`, package names, schema
  `$id`s, localStorage keys.
- The name may not contain "Claude", "Anthropic" or "Copilot".

**Out of scope**

- Embedded terminals, git worktrees, queues, parallel fleets, scheduling.
- A bundled runtime, token or BYOK auth, MCP or custom-agent configuration UI.
- Remote or cloud sessions; driving Claude through any SDK; persisted
  approvals; hosting from the extension.

**Verification**

- `npm run typecheck --workspaces --if-present`, `npm run lint --workspaces
  --if-present`, `npm test --workspaces --if-present`,
  `npm run build -w agent-observability-desktop`.
- Tests use a fake driver; none starts a real CLI: status transitions, the
  permission park → respond → resolve mapping for each answer, abort and quit
  resolving pending requests, both gates, `runtimePath` for a native
  executable and a `.cmd` shim, prefill caps, the reducer, the hosted
  live-board override, the packaging assertion and the source scan.
- Manual: with Run off, every `run.*` RPC refuses. With it on, a session
  started in the app asks before each write and shell command, shows Waiting
  for your approval on the live board, appears once in Sessions under Copilot
  CLI, and resumes from the terminal with `copilot --resume`.

## What was settled differently

Decided by the owner after manual testing on 2026-10-06.

- **Allow all, per session, as the CLI's own mode.** The spec made asking
  the only posture. The Run view now has a picker, **Default permissions /
  Allow all**, on the goal box and on each hosted session. Picking Allow
  all opens a warning and only **Turn on Allow all** applies it. It is the
  Copilot CLI's own allow-all, the mode `copilot --allow-all` starts in:
  the driver calls `session.rpc.permissions.setMode({ mode: 'allow-all' })`
  and the runtime stops raising tool, path and URL requests for that
  session (`manual` switches back). The command-line flag itself is not
  passed, because one CLI process hosts every session and the flag would
  put all of them in allow-all. The session's mode follows the runtime's
  answer: if a policy refuses (`success: false`, or another mode comes
  back) the session stays in the asking mode and says so. The switch is
  recorded in the transcript, held in memory, never a setting or a
  default, and ends when the session is closed, loses its CLI, or the app
  quits. Requests that were already waiting when it is turned on are
  approved one at a time (`approve-once`); a request the runtime still
  raises and marks `managedApprovalRequired` or `requestSandboxBypass` is
  shown. The SDK's `approveAll` handler, the process-wide flags and the
  persistent result kinds stay forbidden under `datahost/run`, and the
  source scan checks that the runtime mode is set in one driver method
  called from one place. Rule 2 of the `AGENTS.md` clause was rewritten to
  match. Verified against CLI 1.0.82 (2026-10-06): with the mode on, a
  file write and a shell command raised no request.
- **"Allow for this session" names its scope.** `approve-for-session` with no
  `approval` is remembered by nothing, so the runtime asked again every time.
  The scope is now derived from the request (`permissionScope.ts`): `read`,
  `write`, `memory`, the request's command identifiers, the MCP or custom
  tool, or the URL's domain. A request with no nameable scope offers only
  once or deny. The controller applies the same scope to requests that were
  already waiting.
- **Requests queue.** The agent can ask for several things in one turn. The
  first build kept one pending request per session, so a second request
  replaced the first and the session waited for ever on a request nobody
  could see. Requests now wait in order and are answered one at a time.
- **The CLI can end; the launch target is checked.** A call that finds the
  CLI gone starts a fresh one and is tried once more, and a session that lost
  its CLI reconnects on the user's next message. On Windows only an `.exe`
  counts as a native executable: in a VS Code terminal the Copilot Chat
  extension puts its own `copilot` wrapper script first on PATH.
