---
applyTo: "src/extension/agent-observability-vscode/**"
description: "Enforce a version bump and CHANGELOG entry on every change to the Agent Observability VS Code extension. Use when editing any file under src/extension/agent-observability-vscode."
---

# Extension versioning & changelog

Whenever you change the **Agent Observability (Local)** extension, you must bump
its version and record the change. This is mandatory, not optional.

## Definition of "a change"

Any edit to extension code or its manifest counts, including:

- `src/**` TypeScript source (behavior, fixes, refactors).
- `package.json` manifest (`contributes`, commands, settings, dependencies).
- Bundling / build config (`esbuild.js`, `tsconfig.json`, `.vscodeignore`).

Documentation-only edits — `README.md` or `CHANGELOG.md` itself — do **not**
require a bump.

## Required steps for every qualifying change

1. **Bump `version`** in
   [package.json](../../src/extension/agent-observability-vscode/package.json)
   following [SemVer](https://semver.org/). While the extension is pre-1.0 (`0.x`):
   - **patch** (`0.1.19 → 0.1.20`): bug fixes, internal refactors, and small
     tweaks with no new user-facing capability.
   - **minor** (`0.1.19 → 0.2.0`): new user-facing features (new command, view,
     setting, or workflow capability).
   - A breaking change before 1.0 is a **minor** bump; call it out clearly in the
     changelog.

2. **Add a CHANGELOG entry** in
   [CHANGELOG.md](../../src/extension/agent-observability-vscode/CHANGELOG.md),
   following the existing [Keep a Changelog](https://keepachangelog.com/) style:
   - Insert a new `## [x.y.z] - YYYY-MM-DD` section at the top, above the previous
     version, using today's date and the exact version you set in `package.json`.
   - Group notes under the relevant headings: `### Added`, `### Changed`,
     `### Fixed`, `### Removed`. Omit headings with no entries.
   - Write user-facing notes (what changed and why it matters), not raw diffs.

3. **Keep them in sync.** The top version heading in `CHANGELOG.md` must always
   equal `version` in `package.json`.

4. **Validate before finishing** (from
   `src/extension/agent-observability-vscode`): `npm run typecheck`,
   `npm run lint`, and `npm test` must pass.

## Privacy reminder

If the change touches the aggregate or sync path, re-confirm that no raw content
field is added to the upload — see
[AGENTS.md](../../AGENTS.md) and
[docs/privacy-validation.md](../../docs/privacy-validation.md).
