# 10. AI Helper

## User story

As a developer reviewing my own agent sessions, I want to ask questions in
plain language (what did I work on this week, which runs struggled and why,
where did the tokens go, what should I have prompted differently) and get
answers grounded in my actual local session data, with follow-up questions
understood in context, so that the observability data becomes a conversation
instead of a set of tables I have to interpret myself.

**Acceptance criteria**

- The AI Helper rail entry opens a chat view instead of the placeholder. The
  assistant answers from the user's own indexed sessions: a summary of recent
  sessions (titles, repositories, verdicts, durations, token and cost
  figures) is always in scope, and answers cite sessions (`[S3]`) that open
  the session with a click.
- The thread is remembered for the whole app run: follow-up questions
  ("why?", "and the one before that?") work because each send replays the
  conversation so far. **New chat** starts over; nothing is ever written to
  disk.
- A session can be attached to the conversation ("Ask AI" from its detail
  view): a capped transcript digest (the same digest the deep retrospective
  sends) grounds questions about that specific run.
- Answers stream in live, can be stopped mid-run (keeping the partial
  answer), and quick prompts cover the common questions (recent activity,
  friction, spend).
- Everything runs through the user's **own local `claude` CLI login**: no
  product API key, tools disabled, one turn per send, no session persistence
  (the app must never ingest its own helper runs).
- On first use the view shows a notice stating exactly what each message
  sends and through what; nothing is sent until it is accepted, and the
  datahost refuses unacknowledged sends independently of the renderer.
- When the Claude Code CLI is not installed, the view is replaced by an
  unmissable warning with the install command, a "Check again" button, and a
  pointer to the Settings field for a custom path. The same availability
  check guards the deep-retrospective dialog and surfaces in Settings.

## Why this matters for research

Every prior proposal built a projection the developer still has to read:
tables (Retro, Hotspots), charts (Dashboard), documents (session detail).
The questions those views exist to answer ("what happened, what went well,
what should I change") are conversational, and the retrospective work
(proposal 9) showed the local corpus can support judged answers. The helper
closes the last gap: it lets the developer interrogate their own corpus
directly, compare sessions in words, and get the "why" behind a verdict
without learning which view holds which number. It is also the first surface
that compounds with every earlier proposal: each new projection (costs,
verdicts, hotspots) becomes something the helper can be asked about.

## Agent spec

**Goal.** Replace the AI Helper placeholder with a streaming chat view backed
by a datahost controller that grounds each send in the local index (and, when
attached, one session's transcript digest), through the existing core chat
stack and the user's own `claude` CLI.

**Grounding: what already exists**

- Core chat stack (`src/core/agent-observability-core/src/chat/`):
  `conversation.ts` (`Conversation`, `assembleMessages(preamble, history)`,
  in-memory only by design), `webview/markdownToHtml.ts` (host-side markdown,
  whitelist tags), `backends/chatBackend.ts` (`ChatBackend` +
  `ChatBackendRegistry`), `backends/claudeCodeBackend.ts` (spawns the user's
  own CLI: `-p --output-format stream-json --include-partial-messages
  --tools "" --max-turns 1 --no-session-persistence`, prompt via stdin).
- `chat/tasks/transcriptDigest.ts`: the capped per-turn digest the deep
  retrospective already sends (`DEEP_RETRO_CAPS`: 1500 prompt chars, 1000
  response chars, 30 turns head-and-tail-sampled).
- Desktop CLI precedent: `datahost/deepRetro.ts` (error-as-value across IPC,
  in-flight dedupe, cancellation) and `datahost/aiBackends.ts` (registry +
  desktop hint text; a future `CopilotCliBackend` around GitHub's standalone
  `copilot` CLI is one more registry entry).
- The working VS Code reference:
  `src/extension/agent-observability-vscode/src/chat/webview/chatViewProvider.ts`
  (60 ms render throttle, full re-render of accumulated markdown per tick).
- View template: `renderer/src/views/retro/RetroView.tsx` (load + subscribe +
  three render branches) and the `OpenSessionIntent` seam in `App.tsx` for
  cross-view "open this session" navigation.
- Config keys already defined and honored by the desktop config reader:
  `aiHelper.claudeCliPath`, `aiHelper.claudeModel`, `aiHelper.claudeEffort`.

**Implementation outline**

1. Core `chat/tasks/assistantGrounding.ts` (pure): `AssistantSessionRow`
   (citation ref + title/repository/timing/counts/verdict/cost),
   `buildAssistantPreamble(corpus, focus?, historyTruncated)`: instructions,
   a one-line-per-session recent-sessions table (40 sessions), totals, the
   optional focus-session digest, a truncation note; `ASSISTANT_QUICK_PROMPTS`;
   `truncateHistory` in `conversation.ts` (24 000 chars, newest turns kept
   whole, the newest user turn always kept).
2. RPC (`shared/rpc.ts` + the exhaustive switch in `datahost/index.ts`):
   `ai.availability`, `ai.state`, `ai.send`, `ai.stop`, `ai.reset`,
   `ai.acknowledge`; push event `ai.assistantDelta { runId, html }` carrying
   the whole accumulated answer host-rendered per tick.
3. Datahost `aiHelper.ts`: owns one `Conversation` and the send pipeline:
   consent check (`aiHelper.disclosed`), availability, grounding from the
   index (renames applied, hidden sessions excluded), history replay,
   streaming with Stop + 300 s safety timeout, citation linkification to
   `<a data-source data-id>` (no `href`).
4. Renderer `views/assistant/AssistantView.tsx`: CLI-missing hero →
   first-use notice → chat (assistant HTML via host-rendered markup; click
   interception routes citations to the Sessions view and external links to
   the OS browser, never the app window). Delete `PlaceholderView.tsx`.
5. "Ask AI" from the session detail sets the attach (focus) session via an
   `AskAiIntent`, mirroring `OpenSessionIntent`.

**Constraints**

- **Privacy: the second sanctioned exception.** The helper sends raw session
  content (titles, repositories, capped transcript excerpts) to Anthropic
  through the user's **own local `claude` CLI login** only. No product API
  key, never in the background, never on the aggregate/sync path. Gate: a
  one-time first-use notice in the view naming exactly what each message
  carries, enforced again in the datahost. Every send is an explicit user
  action. See the privacy invariant in `AGENTS.md`; nothing else may cite
  this exception as precedent.
- The CLI runs with `--tools ""` and `--max-turns 1`: there is no tool loop,
  so all grounding must be in the prompt, and multi-turn context is carried
  by replaying (truncated) history each send.
- The renderer owns no markdown parser and no charting library (strict CSP);
  assistant markup is rendered in the datahost.
- Chat transcripts are never persisted to disk.

**Out of scope**

- A Copilot CLI backend (GitHub's standalone `copilot` CLI). The registry
  seam is ready (it is one `ChatBackend` implementation plus a `BackendId`),
  but it would extend the privacy exception to a second vendor and needs
  its own decision. It later shipped in 1.14.0 with proposal 11.
- Persisting chat threads across app restarts.
- Tool use / agentic loops in the helper.
- A free-form session picker in the chat (attach flows through the session
  detail's "Ask AI" for now).

**Verification**

- `npm run typecheck --workspaces --if-present` and
  `npm test --workspaces --if-present` from the repo root.
- Manual, with `claude` on PATH: first-use notice appears exactly once;
  quick prompt streams an answer with `[S*]` citations that open sessions;
  a follow-up question shows the thread is remembered; Stop keeps the
  partial answer; "Ask AI" on a session attaches it and transcript-specific
  questions work.
- Manual, without the CLI (point `aiHelper.claudeCliPath` at a nonexistent
  file in Settings): the helper shows the blocking warning, Settings shows
  it inline, the deep-retro dialog blocks with the same reason, and no
  message ever mentions a VS Code setting id. Clearing the path and pressing
  "Check again" recovers without an app restart.
- No `claude` process may spawn before the notice is accepted and a send is
  made.
