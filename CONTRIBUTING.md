# Contributing

Thanks for helping out. Bug reports, ideas and pull requests are all welcome.

## Before you start

- For anything bigger than a small fix, open an issue first so we can agree on
  the approach.
- Read [AGENTS.md](AGENTS.md). It is written for AI coding agents, but it is
  also the best map of the repo for people: where code goes, how to build and
  test, and the rules every change must keep.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Set up

You need Node.js 22 and npm.

Install every package once, from the repo root:

```bash
npm install
```

## Build and test

From the repo root, across all packages:

```bash
npm run typecheck --workspaces --if-present
npm run lint --workspaces --if-present
npm test --workspaces --if-present
```

Desktop app:

```bash
npm run dev -w agent-observability-desktop    # run with hot reload
npm run package -w agent-observability-desktop  # build installers
```

## Rules for every change

These are explained in full in [AGENTS.md](AGENTS.md). The short version:

1. **Raw content never leaves the machine.** Prompts, responses, tool input and
   output, file paths, names, branches and commits must never reach the team
   shard. Its format is fixed by
   [schemas/team-shard.schema.json](schemas/team-shard.schema.json).
2. **Tests must pass on any machine.** Do not assert on locale, time zone,
   clock speed or path separators. CI runs on Windows and macOS.
3. **Changelogs are for users.** If a user can see or do something differently
   after your change, bump the desktop app's version and add an entry to its
   `CHANGELOG.md`. Refactors, tests, CI and docs get no entry.

## Pull requests

- Keep each pull request to one topic.
- Make sure typecheck, lint and tests pass.
- Describe what changed for the user, and how you tested it.
