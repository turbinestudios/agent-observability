# Changelog

All notable changes to the Agent Observability desktop app are documented in
this file. It is written for the people who use the app, and it is what the
**What's new** dialog inside the app shows — so every entry describes something
a user can see or do differently. Internal work leaves no trace here.

The format follows [Keep a Changelog](https://keepachangelog.com/) and the
project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-08-28

### Added

- **What's new** — the sparkle in the sidebar opens this changelog without
  leaving the app.

### Fixed

- **Opening the first Copilot session after launch no longer takes minutes.**
  Everything a session records — prompts, tool definitions, system instructions
  — lives in one table with no way to look a row up by name, so the queries
  behind the detail view had to read the whole thing, which on a well-used
  archive is over a gigabyte. Two of those queries ran on the first session
  opened after launch, which is why only that one was slow. The app now adds the
  missing index to its own archive at startup, once, and nothing is re-imported.

## [1.0.1] - 2026-08-27

### Added

- A **Settings** view: choose which sources are indexed, exclude repositories
  you do not want listed, and point the app at a different database. Changes
  apply straight away and survive a restart.
- **Hide or permanently delete a session.** Hiding takes it out of the list and
  keeps it out; deleting erases the transcript or the telemetry rows for good.
  The dialog names the file it would remove before you confirm.

## [0.2.0] - 2026-08-27

### Added

- **GitHub Copilot sessions** alongside Claude Code, with a source filter to
  show one or both.
- **Dashboard** charts over the last 30 days, and a progress indicator while the
  session list is being built.
- **Rename a session** to something you will recognise later.
- **Dark mode**, following the system appearance, with a toggle in the sidebar.
- A spinner while a large session is being opened, instead of a frozen window.

### Fixed

- Session detail, tab clicks and renames no longer stop working after a refresh.
- Copilot sessions now show the repository they ran against instead of
  "unknown", resolved from the workspace even when the session did not record it.

## [0.1.0] - 2026-08-27

### Added

- First standalone desktop app: a fast, indexed list of your Claude Code
  sessions with the full turn-by-turn detail view, reading the same on-disk data
  as the VS Code extension. Nothing leaves the machine.
