# Security policy

## Reporting a problem

Please do not open a public issue for a security problem.

Report it privately instead, through GitHub:
[Report a vulnerability](https://github.com/turbinestudios/agent-observability/security/advisories/new).

Tell us what you found, how to reproduce it, and what an attacker could do
with it. We will reply within a week and keep you posted until it is fixed.

## What counts

We especially want to hear about anything that could:

- send prompts, responses, tool input or output, file paths, or names off the
  user's computer without the user asking for it
- let a repository or workspace change where data is sent
- let the AI features write files outside the context files they are allowed
  to change
- let a team shard from the shared folder carry, or be merged with, anything
  its schema does not allow

The rules the code must keep are listed under "Privacy invariant" in
[AGENTS.md](AGENTS.md#privacy-invariant-do-not-break).

## Supported versions

Only the latest release of the desktop app gets security fixes.
