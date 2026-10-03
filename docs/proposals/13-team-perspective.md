# 13. Team perspective

## User story

As a developer on a team that uses coding agents, I want to see how my team
uses them, anonymously and without any server, so that I can compare my own
practice with the team's, see which repositories and context files cause
friction for everyone, and watch adoption, with nothing more than a folder we
already share.

**Acceptance criteria**

- A **Team** entry in the sidebar opens a view with a 7 / 30 / 90-day window
  and these cards over every member's shard found in the team folder: members
  active per day, sessions per day, tokens per day, estimated cost per day with
  its billing basis spelled out, how sessions went per day and over the window,
  busiest repositories, shared context hotspots, adoption over time, and, when
  the viewer's own shard is in the folder, **me vs team** (mine, team median,
  team mean, rank). A members list shows each anonymous id (shortened), a
  **you** badge, last export time, app version and a stale marker; every file
  that could not be merged is listed with why.
- **Settings > Team** lets the user pick the folder (native folder picker),
  turn **Share my aggregates with the team folder** on (off by default) behind
  a disclosure dialog that names the folder, lists what is and is not shared,
  and lists every repository that would be included with a checkbox each,
  turn hourly automatic export on or off, and **Preview what will be shared**:
  the exact JSON, byte for byte.
- Reading the folder is always on and read-only. Every file is validated
  against the shard contract before it is merged; a file written by a newer
  app version, an invalid file, a mis-named file, an oversized file or one
  still syncing is skipped with a visible notice, never merged in part.
- The shard is one JSON file per member named after their anonymous id,
  rewritten whole on each export, covering the last 90 days, and containing
  the **unchanged** aggregate batch, the **unchanged** context-insights batch,
  and per-day, per-repository, per-source session-outcome counts (sessions,
  verdict mix, estimated cost). Nothing in it is a title, a prompt, a name, a
  branch, or a path beyond the already-sanctioned repo-relative context-file
  names.
- The datahost refuses to export unless sharing is on **and** consent was
  recorded, before gathering a single row; a hand-edited `true` in
  `config.json` does not share. The built shard is validated before it is
  written, and written through a temp file and a rename so no reader ever
  sees a partial file.
- Each install has its own anonymous id (its own salt, in its own 0600 file,
  never in `config.json`, never in the folder), so the same person on two
  computers counts as two members. This is documented in Settings and here.

## Why this matters for research

Every earlier proposal is one person's view of one person's sessions. Agent
adoption, context-file quality and spend are team questions, and the cloud
dashboard that was meant to answer them needs infrastructure nobody wants to
run. A folder the team already shares, carrying the same schema-bound
aggregates the dashboard would have received, answers the team questions with
zero servers and lets each member compare themselves against the group
without anyone being named.

## Agent spec

**Goal.** A new schema-bound artifact (the team shard) embedding the two
existing batch contracts by reference plus one closed-set `outcomes` block; a
pure core pipeline (build, validate, merge, metrics); a datahost export gated
exactly like the other consent surfaces, a read-only folder reader with a
poll-first watcher, and an hourly scheduler; a folder picker in main; a Team
view and a Settings card in the renderer. No index schema change. The
extension's sync path is untouched.

**Grounding: what exists (all shipped with this proposal)**

- Contract: `schemas/team-shard.schema.json` (`$ref`s the two batch schemas by
  `$id`; `additionalProperties:false` everywhere).
- Core, pure: `src/core/agent-observability-core/src/team/teamShardModels.ts`
  (types, constants), `team/teamShardBuilder.ts` (`buildTeamShard` over the
  unchanged `buildBatch` and `buildContextInsightsBatch`, `buildOutcomeRows`,
  `utcDay`, `clampTeamWindow`), `aggregate/batchValidators.ts` (TypeScript
  ports of the dashboard's `AggregateBatchValidator.cs` and
  `ContextInsightsBatchValidator.cs`, plus unknown-key rejection at every
  level), `team/teamShardValidator.ts` (`validateTeamShard`,
  `isUnknownShardVersion`), `team/teamMerge.ts` (`mergeShards`, latest
  `generatedAt` wins, mis-named files refused), `team/teamMetrics.ts`
  (`computeTeamMetrics`, UTC days, sessions from outcomes never from bucket
  counts), `team/teamViewModels.ts`, `analysis/hotspotScore.ts` (moved from
  the desktop, generic over `Scorable`), `consent/consentDisclosure.ts`
  (`TEAM_WHAT_IS_SHARED`, `teamConsentDetail`, and the corrected
  `WHAT_IS_NOT_SHARED`).
- Desktop datahost `datahost/team/`: `teamSalt.ts` (own 0600 file),
  `teamState.ts`, `teamShardSource.ts` (rows from every enabled source with
  hidden sessions and the repository policy applied; context observations
  made repo-relative under the re-verified checkout root or dropped;
  outcomes with the source's cost mode), `teamExport.ts` (gate first, build,
  validate, tmp+rename; `previewTeamShard` ungated), `teamFolder.ts`
  (`readTeamFolder`, `TeamFolderWatcher`), `exportScheduler.ts`,
  `teamController.ts` (the six RPCs); `IndexDb.outcomeInputs` and
  `contextFileObservationRows`; settings keys `team.folder`,
  `team.shareEnabled`, `team.consentedAtMs`, `team.autoExport`,
  `team.repositoryMode` (default `all`), `team.repositories`.
- RPC: `team.status`, `team.refresh`, `team.preview`, `team.exportNow`,
  `team.view`, `team.members`; event `team.changed`; `toolVersion` arrives on
  the main → datahost port handshake.
- Main/preload: `app:pick-folder` and `window.desktop.pickFolder()`.
- Renderer: `views/team/*` (`TeamView`, `TeamConsentDialog`,
  `TeamPreviewDialog`, pure `team.ts`), the `Team` rail entry, the Settings
  card.

**Constraints**

- **Privacy.** The shard is the fourth and last thing allowed to leave the
  machine, and the only one by file; see `AGENTS.md` and
  `docs/privacy-validation.md` rows 20–24. Never add a field to
  `core/src/team/*` or `datahost/team/*` that is not a count or a closed-set
  label. The two embedded batches may only be referenced by their schema
  `$id`, never copied or extended. Update the TypeScript validators in the
  same change as the C# ones.
- The salt never leaves `~/.agent-observability/desktop/team-salt`. Anyone
  with the folder and the team's emails could otherwise reverse the ids.
- Days are UTC and bucketed by the producer; the importer never re-bins.
- The repository policy defaults to `all` (unlike the extension's
  include-empty default) because the destination is a folder the user chose
  and the exact JSON is previewable; the consent dialog lists every repository.
- No chokidar: the folder watcher is poll-first with `fs.watch` as a latency
  hint, because network shares and OneDrive placeholders make events
  unreliable.

**Out of scope**

- Uploading shards anywhere; a third dashboard contract for `outcomes` (the
  embedded batches stay POST-able to the dashboard as they are).
- Org-shared salt provisioning (one person, one id across machines).
- Names, display names, titles, or any text beyond closed-set labels.

**Verification**

- `npm run typecheck --workspaces --if-present`, `npm run lint --workspaces
  --if-present`, `npm test --workspaces --if-present` from the repo root.
- Manual, two installs (two user profiles, or a second config dir via a
  second machine) pointed at one shared folder: with sharing off, **Export
  now** is absent and a forced `team.exportNow` RPC returns the refusal; turn
  sharing on through the dialog, confirm, and a `dev_….json` appears in the
  folder that validates against `schemas/team-shard.schema.json`; the other
  install's Team view shows two members within a minute; hand-edit a shard to
  add an unknown key and it is skipped with "not a valid team file"; change a
  copy's `schemaVersion` to `9.0` and it reads "written by a newer version";
  unmount or rename the folder and the chip reads missing, then recovers when
  it returns.
