# 23. Share a session

## User story

As a developer, I want to send one of my agent sessions to a colleague as a
file, so that they can import it into their own app and compare it with a
session of theirs: the same task done two ways, or a run that went well
beside one that did not.

**Acceptance criteria**

- An open session has a **Share…** action. It opens a dialog that says,
  before anything is written, that the file holds the **full conversation**
  (prompts and final responses), the title, repository, models, tool names,
  timings, tokens, lines changed and cost. It also says what the file leaves
  out: tags, notes, hidden flags, tool inputs and outputs, file paths, and
  anything that identifies the user or the computer.
- Secret-looking strings are redacted before the file is written. The dialog
  shows how many and calls the redaction best effort.
- Nothing is written until the user picks a location in the save dialog, and
  only there. The app never sends the file anywhere.
- The Sessions list has an **Import** button and accepts a dropped file. A
  valid file appears under the source **Shared** and opens straight away. An
  invalid one is reported with its problems, and nothing is stored.
- An imported session can be opened, ticked with the user's own sessions and
  **compared**. It keeps the cost basis it was recorded in (AIU, USD or
  credits).
- Imported sessions never count in the receiver's own figures: dashboard,
  insights, hotspots, retrospective trends, evidence, workspace, inbox, AI
  Helper corpus and team shard.
- An imported session cannot be shared again, sent to an AI backend, handed
  off, resumed or run. Deleting it removes only the app's own copy.
- Importing the same session again replaces the earlier copy.

## Why this matters

Comparing two runs of the same task is the clearest way to learn what a
prompt, an instruction file or a model change does. Until now that comparison
stopped at the edge of one machine. The team shard deliberately carries counts
only, and the review packet and hand-off brief leave only through the
clipboard, as Markdown that cannot be compared.

## Agent spec

**Goal.** Export one session to a JSON file, import such a file on another
machine, and serve it through the existing session detail and Compare, with no
changes to either.

**Grounding**

- Format: `schemas/shared-session.schema.json` (v1.0), **generated** from
  core `share/sharedSessionShape.ts`. The same shape definition drives:
  - the exporter's allowlist (`pickShape`);
  - the importer's validator (`validateShape`);
  - the schema file itself.

  A test regenerates the schema and fails on any difference, and checks ajv
  parity.
- Envelope: `kind`, `schemaVersion`, `exportedAtMs`, `toolVersion`,
  `origin { source, costMode }`, `redactions { count, kinds }`, and `detail`
  (a `SessionDetail` minus `titleOriginal`, `externalUrl` and
  `summary.source`).
- Core:
  - `share/sharedSession.ts` holds the builder (allowlist, then
    `redactSecrets` over titles, prompts and responses, then self-validation),
    the validator, and the stable id: `<origin source>.<sha256(source, original
    id)[:16]>`.
  - `share/sharedSessionSource.ts` implements the `SessionDataSource` that
    serves `~/.agent-observability/desktop/shared/<id>.json`, re-validating
    each read. Its `costModeOf` gives each session its own basis. Aggregation
    rows and the overview are empty.
- Desktop:
  - Main gets two native dialogs (`app:pick-share-save`, `app:pick-share-open`).
    The preload exposes `webUtils.getPathForFile` for drops.
  - The data host:
    - adds the `share.preview`, `share.export`, `share.import` and
      `share.origin` RPCs (in `datahost/share/shareFiles.ts`);
    - adds `indexer/sharedIndexer.ts`, which runs in the worker and
      synchronously after an import;
    - adds `share/figures.ts`, the exclusions every aggregate reads instead of
      the hidden store.
  - The renderer:
    - adds `ShareDialog.tsx` and the Import button and drop target in
      `SessionsView.tsx`;
    - shows an origin banner on imported sessions, and gates the actions an
      imported session must not offer.

**Constraints**

- AGENTS.md "Sharing one session as a file" is the governing clause. It is
  not one of the AI-backend exceptions.
- The export path must end in `.aosession.json` and be absolute. The data
  host refuses anything else even though the save dialog proposes it.
- The deep retrospective button is never offered for an imported session.

**Out of scope**

- Retrospective and context analysis in the file. The receiver derives its
  own retrospective from the turns. The context analysis names the sender's
  file paths and is not shared.
- Sharing several sessions in one file, clipboard transport, and any upload.

**Verification**

- `share/sharedSession.test.ts` (core) and `datahost/share/share.test.ts`
  (desktop) cover redaction, the allowlist, unknown keys, version handling,
  the schema parity, refusing an invalid import, replacing on re-import,
  indexing, removal, and the exclusion from aggregates.
- By hand:
  1. Share a session and import the file.
  2. Compare it with one of your own.
  3. Check the dashboard totals did not move.
  4. Delete it and check the copy is gone.
