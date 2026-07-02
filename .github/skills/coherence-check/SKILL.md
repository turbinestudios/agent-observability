---
name: coherence-check
description: >
  After subagents complete implementation work, review a configured list of key files and update any that have drifted from the current state of the codebase. This skill always runs — it is not conditional. Execute this skill **after all subagent delegations are complete** and **before** evaluating whether a reflection is needed. Run it for every implementation task, regardless of scope or complexity.
---

# Skill: Coherence Check

## Key Files Configuration

The list of key files to review is defined in:

`.github/skills/coherence-check/coherence-check-key-files.yml`

Each entry has:
- `path` — a file path or directory glob to review
- `purpose` — what to look for when evaluating coherence

## Review Process

1. **Load the configuration** — Read `.github/skills/coherence-check/coherence-check-key-files.yml`
   to get the list of files and folders to review.

2. **Gather session context** — Identify all files that were created,
   modified, or deleted during this session by the subagents.

3. **Review each key file** — For every entry in the configuration:
   - Read the file (or all files in a directory entry).
   - Compare its contents against the changes made in this session.
   - Determine whether the file is still accurate and complete, or
     whether the session's changes have made it outdated.

4. **Update directly** — If a key file is outdated or incomplete:
   - Edit it to reflect the current state of the codebase.
   - Maintain the file's existing style, structure, and conventions.
   - Make the minimum changes necessary — do not rewrite or reorganize
     content that is still accurate.

5. **Confirm when no changes needed** — If a key file is still coherent
   after reviewing, note it as reviewed with no update required.

## Update Guidelines

- Preserve the original author's style and formatting conventions.
- Only add, modify, or remove content that is directly affected by
  the session's changes.
- Do not introduce new sections, restructure, or "improve" content
  beyond what coherence requires.
- If a key file references artifacts that no longer exist, remove or
  update those references.
- If the session introduced new artifacts that should be reflected in
  a key file, add them.

## Reporting

After completing the review, report to the operator with a brief summary:

```
## Coherence Check

Reviewed [N] key file(s).

- **[file/folder path]**: [Updated / No changes needed] — [one-line reason]
- **[file/folder path]**: [Updated / No changes needed] — [one-line reason]
```
