# 21. Copilot in JetBrains IDEs as a session source

## User story

As a developer who uses GitHub Copilot in Rider (or another JetBrains IDE), I
want those chats listed beside my other agent sessions, so that the app shows
all my agent work wherever it happened, even when it cannot show what it cost.

**Acceptance criteria**

- Copilot chats from JetBrains IDEs appear under the source **Copilot
  (JetBrains)**, one session per conversation, with title, repository when one
  can be found, turns, models and times.
- They show no token counts and no cost, because the plugin records neither.
  They are never shown as $0.
- Settings has a toggle (on by default) and a folder override, and says where
  it looked and how many chat stores it found there.
- A store the IDE holds open keeps the sessions read from it before; a store
  the reader cannot make sense of produces no sessions and an index note,
  never an error.
- The app only reads the plugin's folder. Deleting a session is hide-only.
  These sessions are not shared in team shards.

## Why this matters for research

JetBrains users are a large share of Copilot users, and nothing they do
appears today. Even without usage figures, their sessions count towards how
often agents are used per repository, how long sessions run, and which models
are picked.

## Agent spec

**Goal.** A read-only reader for the Copilot JetBrains plugin's chat store, a
source and a desktop indexer for it, and a probe that checks the reader
against a real machine.

**Grounding: what the store is (NOT verified on disk)**

No JetBrains IDE was installed on the machine this was built on. Everything
below comes from codeburn's provider notes
([docs/providers/copilot.md](https://github.com/getagentseal/codeburn/blob/main/docs/providers/copilot.md),
MIT), the only public description found:

- Location: `%LOCALAPPDATA%\github-copilot\<ide>\<kind>\<storeId>\copilot-*-nitrite.db`
  on Windows, `$XDG_CONFIG_HOME/github-copilot` or `~/.config/github-copilot`
  elsewhere. `<kind>` is `chat-agent-sessions`, `chat-sessions` or
  `chat-edit-sessions`; `bg-agent-sessions` holds file snapshots, not chats.
  `<ide>` is a product code (`iu`) or a versioned name (`PyCharm2025.2`);
  Rider's is not documented.
- Format: an H2 MVStore file (header `H:2,block:9,…format:3`) of
  Java-serialized Nitrite documents (`NtAgentSession`, `NtAgentTurn`).
- A conversation is a GUID with an evolving `title`; `projectName` appears from
  plugin 1.12. Agent and plan mode keep the reply in an `AgentRound`'s `reply`
  and the prompt in a `Markdown` `text`; ask mode keeps the reply in a
  `Markdown` `text`. `Thinking`, `PendingChanges`, `AskQuestion`,
  `Notification` and `SubTurn` are side records. Plugins up to 1.5.x stored a
  whole session as one document.
- **No token counts are stored.**
- On this machine the same root holds only Copilot for Visual Studio's files
  (`auth.db`, symbol databases, `versions.json` with `copilot-vs`), which the
  reader ignores.

**Grounding: what was built**

- Core `copilotJetbrains/`: `paths.ts` (root, discovery, IDE names),
  `nitriteScan.ts` (Java-string extraction, record and key reading,
  de-duplication of superseded page copies, timestamp recovery from
  serialized longs), `mapper.ts`, `copilotJetbrainsSource.ts`.
- Desktop: `copilotJetbrainsIndexer.ts` (one `files` row per store carrying
  the ids it produced, so an unchanged store is skipped), worker and live
  board wiring (each store watched as a file), Settings toggle, folder override
  and found-stores line, source chip and chart colour.
- `scripts/jetbrainsProbe.ts`: structure-only report of what the reader makes
  of the stores on a machine (`npx vite-node scripts/jetbrainsProbe.ts`).
  It prints counts, record names and header bytes, never content, titles or
  project names.

**Constraints**

- Read-only: each store is read whole into memory; nothing is opened for
  writing and no lock is taken.
- Every field the scanner reads is optional. A record it cannot decode is
  dropped, never guessed.
- Not shared in team shards; no shard or index schema change.

**To verify on a machine with Rider**

- The `<ide>` folder name Rider uses, and that stores sit at the documented
  depth.
- That the probe finds conversations with titles and turns with prompts and
  replies, and that the counts match what the IDE's chat history shows.
- Whether pages are compressed (the scanner would then find no strings and
  report every store as not recognised).

**Out of scope**

- Estimating tokens from text length (codeburn does; here an unrecorded figure
  stays unrecorded).
- JetBrains AI Assistant and Junie, which keep their own, different stores.
- Tool calls, context analysis and live status for this source.

**Verification**

- Tests build stores byte by byte in the documented shape: titles that change,
  agent and ask turns, side records left out, a superseded half-written copy
  folded in, the legacy layout, noise that must yield nothing, a locked file,
  discovery that ignores Visual Studio's files and background snapshots.
- Desktop tests: an unchanged store is skipped, a changed one re-read, a
  locked one keeps its rows, a removed one drops them.
- Not yet verified against a real store. Run the probe on the Rider machine
  first.
