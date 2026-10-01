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
- let a repository or workspace change where data or API keys are sent
- let the AI features write files outside the context files they are allowed
  to change
- give someone access to a team dashboard, or its data, without signing in or
  holding a valid API key

The rules the code must keep are listed under "Privacy invariant" in
[AGENTS.md](AGENTS.md#privacy-invariant-do-not-break).

## Supported versions

Only the latest release of the desktop app and the VS Code extension gets
security fixes.
