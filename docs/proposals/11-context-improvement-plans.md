# 11. Context Improvement Plans

## User story

As a developer maintaining CLAUDE.md, AGENTS.md, and instruction files, I want
to pick the context files my agents overload or skip and the sessions that
struggled, send that evidence to my own AI CLI, and get back a concrete,
appliable plan for how those files should change, so that tuning context
stops being guesswork and the observability data starts fixing the thing it
measures.

**Acceptance criteria**

- An Improve view lets me pick one repository, up to 8 of its context files
  (from the hotspots ranking) and up to 5 of its judged sessions (from the
  retro ranking), and generate a plan; the Hotspots and Retro views offer an
  "Improve context…" door once a repository is selected.
- Generation runs through my selected AI backend (Claude Code or the GitHub
  Copilot CLI) and is double-gated: a default-off Settings toggle, plus a
  per-generation dialog naming the vendor and exactly what is sent. The
  datahost refuses a gate-off call independently of the renderer.
- The plan renders as markdown with a machine-readable edit list; proposals
  that fail validation are dropped and counted visibly. A reply with no
  readable edit block still shows its narrative; Apply is simply absent.
- Each proposed edit can be previewed as a diff against the file **as it is
  now** and applied individually; a file changed since generation refuses as
  stale, applied files can be undone from an automatic backup, and nothing is
  ever deleted. Only allowlisted context files under the re-verified repo
  root can be written.
- Plans and their backups are stored only on this machine, beside the
  deep-retro store, and survive index rebuilds.

## Why this matters for research

Every prior proposal measures context: proposal 3 ranks the files agents
load, proposal 9 judges how sessions went, proposal 10 lets the developer ask
why. This one closes the loop the product exists for: it turns that evidence
into reviewed, reversible changes to the instruction files themselves, which
are the main lever a team has over agent behavior.

## Agent spec

**Goal.** A selection UI over the existing hotspot/retro rankings, a pure core
task that builds the prompt and tolerantly parses an `ao-context-plan` fenced
JSON contract (full-file replacements, never hunks), a gated datahost runner
mirroring the deep retrospective's, a JSON plan store with undo backups, and
an apply path constrained to the customization allowlist.

**Grounding: what already exists (all shipped with this proposal)**

- Core task: `src/core/agent-observability-core/src/chat/tasks/contextImprovement.ts`
  (`IMPROVE_LIMITS`, `buildContextImprovementPrompt`, `parseContextPlan`);
  diffing in `core/src/text/lineDiff.ts`; repo-root climb via `findRepoRoot`
  in `chat/tasks/projectContext.ts`, contents via `gatherProjectContextFiles`.
- Backends: the shared `ChatBackend` registry: `claudeCodeBackend.ts` and
  `copilotCliBackend.ts` (`copilotCliArgs.ts` documents the probed CLI
  behavior, including the payload-file transport for large prompts).
- Desktop: `datahost/improve/contextPlan.ts` (gate `improve.enabled`, 240 s
  timeout, per-repo in-flight dedupe, injectable `runPrompt`/root/gather
  seams), `contextPlans.ts` (JSON store, `MAX_STORED_PLANS`, prune never
  evicts undo state), `contextPlanApply.ts` (the one sanctioned write path),
  `repoRoot.ts` (repository → checkout, remote re-verified); RPCs
  `improve.repoStatus/generate/plans/plan/diff/apply/undo` in `shared/rpc.ts`;
  renderer `views/improve/ImproveView.tsx`.

**Constraints**

- **Privacy: the third sanctioned exception.** See `AGENTS.md` (which also
  defines the one sanctioned local write path this proposal introduces) and
  `docs/privacy-validation.md` rows 17–18. Ground rule 1 in this folder's
  README names all three exceptions. Nothing else may cite them as precedent.
- Absolute paths never enter the prompt; hotspot identities are mapped
  repo-relative first.
- Full-file replacement over hunks, deliberately: a mis-applied hunk corrupts
  silently, a full file either validates or is dropped whole, and staleness
  becomes a hash comparison.
- The renderer owns no markdown parser and never touches the filesystem; the
  datahost renders the narrative and does every write.

**Out of scope**

- Applying edits automatically, editing files outside the customization
  allowlist, or any delete action.
- Multi-repository plans.
- Feeding plan outcomes back into the retrospective engine (a future loop).

**Verification**

- `npm run typecheck --workspaces --if-present` and
  `npm test --workspaces --if-present` from the repo root.
- Manual, gate off: the Improve view's generate button is disabled with a
  Settings pointer, and a forced `improve.generate` RPC returns the refusal.
- Manual, gate on + confirmed: generate a plan for a real repository; apply
  one file after previewing its diff; edit the file externally and watch a
  second apply refuse as stale; undo restores the original; no `claude` or
  `copilot` process spawns before the dialog is confirmed.
