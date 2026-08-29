# CLAUDE.md

The agent guide for this repository is **[AGENTS.md](AGENTS.md)** — repository
map, build and test commands, where code goes, and the privacy invariant. Read
it first. Nothing from it is copied here, so the two can never drift apart.

Four rules there are absolute, and are repeated as pointers only so they are
not missed:

- **[Never commit or push](AGENTS.md#never-commit-or-push)** — no `git commit`,
  `git push`, `git tag` or `gh pr create` unless the user asks for it in that
  message. Leave the work in the tree and say what changed.
- **[Changelogs record user-facing change only](AGENTS.md#changelogs-user-facing-change-only)**
  — an entry when a user can see or do something differently, and never for
  internal work. The desktop app renders its own `CHANGELOG.md` in the What's
  new dialog, so the format is load-bearing.
- **[The privacy invariant](AGENTS.md#privacy-invariant-do-not-break)** — raw
  content never leaves the machine.
- **[Tests must not depend on the machine that runs them](AGENTS.md#tests-must-not-depend-on-the-machine-that-runs-them)**
  — never assert on locale, timezone, clock speed, or path separators. A green
  local run proves nothing about CI, and the release workflow tests *after*
  tagging, so a failure there strands a tagged version with no installers.
  This has now cost two releases.
