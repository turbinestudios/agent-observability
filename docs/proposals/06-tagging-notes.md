# 6. Session tagging & research notes

## User story

As a developer running experiments with agents, I want to tag sessions (for
example "experiment-A", "bad-run", "baseline") and attach short notes, so that
I can build labeled sets of runs to revisit, filter, and compare.

**Acceptance criteria**

- I can add and remove tags on a session from its list row and from the
  detail pane; new tags are created on the fly; tag chips are visible on
  rows.
- I can filter the list by tag, combinable with the source filter, search,
  and (once proposal 5 lands) repository/date filters.
- I can attach a free-text note to a session, edited from the detail pane; a
  subtle indicator on the row shows a note exists.
- Tags and notes survive an index rebuild and app updates, and never leave
  the machine.
- Tag filtering composes with multi-select (proposal 1): filter to a tag,
  select all, compare.

## Why this matters for research

Disciplined agent research needs labeled corpora: "the ten runs with the old
prompt" vs "the ten with the new one", "every run that went off the rails".
Renaming (the only annotation today) can hold one fact; tags hold membership
in many sets at once, and notes preserve the *why* ("went sideways after it
ignored the test instruction") that is lost by the time a retro happens. Tags
are also the natural input for comparisons and future per-tag rollups.

## Agent spec

**Goal.** Add per-session tags and notes, stored in JSON stores beside the
existing renames, with tag chips, a tag filter, and note editing in the UI.

**Grounding: what already exists**

- The exact pattern to copy: `RenameStore` in
  `src/desktop/agent-observability-desktop/src/datahost/renames.ts` (tests in
  `renames.test.ts`) and `HiddenStore` in `src/datahost/hidden.ts`: JSON
  files in `~/.agent-observability/desktop/` keyed by source + sessionId,
  deliberately **outside** `index.db` so a cache rebuild cannot lose user
  data. Atomic temp-file-plus-rename writes as in
  `src/datahost/drivers/desktopConfig.ts`.
- Overlay precedent: search already runs a union pass over renames because
  the index stores original titles (`indexDb.ts` + `useSessions.ts`). Tag
  filtering is the same kind of overlay: the store is small and in-memory in
  the datahost, so filter by intersecting the SQL page with the tag's session
  keys (or pass the keys into SQL as a list).
- Row updates flow through the existing `sessions.upserted` push event, so
  tagging updates rows in place without reordering, the same as rename does
  today.
- RPC contract: `src/desktop/agent-observability-desktop/src/shared/rpc.ts`;
  dispatch: `src/datahost/index.ts`. List UI:
  `src/renderer/src/views/sessions/SessionsView.tsx` (row hover actions:
  rename, remove; follow their interaction patterns); detail pane chrome:
  `SessionDetail.tsx` (add tag/note controls in the React chrome around the
  iframe, **not** inside the rendered HTML document).

**Implementation outline**

1. **Stores.** `TagStore` (`tags.json`: map of `source:sessionId` to string
   array, plus normalization: trim, collapse case for matching, keep display
   case) and `NoteStore` (`notes.json`: map to a single string). Follow
   `RenameStore`'s shape, loading, and atomic-write behavior.
2. **RPC.** `sessions.setTags(source, id, tags)`,
   `sessions.setNote(source, id, note)`, `tags.list()` (all known tags with
   counts, for the filter and the tag-picker), and a `tag?: string` param on
   `sessions.list`. Extend `SessionRow` with `tags: string[]` and
   `hasNote: boolean`, populated from the stores when rows are materialized
   (same place renames overlay today).
3. **UI.** Tag chips on rows (truncate past 2–3 with a "+N"); a tag-editor
   popover from a row hover action and from the detail pane header; a tag
   filter chip row (from `tags.list()`); a note editor (textarea) in the
   detail pane with debounced save; a small note indicator on rows.
4. **Changelog + version.** Minor bump; `### Added` entry ("Tag sessions and
   attach notes; filter the list by tag").

**Constraints.** All ground rules in
[README.md](README.md#ground-rules-every-agent-spec-inherits-these). Tags and
notes are user-created raw content: they live only in the local JSON stores
and must never be written to `index.db` (rebuild-safety) nor to any sync or
aggregate path.

**Out of scope.** Per-tag analytics rollups on the Dashboard (natural
follow-up once tags exist), hierarchical or colored tags, tag
rename/merge tooling, syncing tags anywhere.

**Verification**

- Unit tests for both stores (set/get/remove, persistence across reload,
  atomic write) and for tag filtering combined with source + search in the
  list path.
- `npm run typecheck -w agent-observability-desktop`,
  `npm test -w agent-observability-desktop`.
- Manual: tag two sessions, filter by the tag: only they show; use **Rebuild
  index** in the flow (or delete `index.db`): tags and notes survive; note
  indicator appears and the note text round-trips after an app restart.
