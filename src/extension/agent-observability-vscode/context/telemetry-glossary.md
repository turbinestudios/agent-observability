# Telemetry glossary

Use these definitions when summarizing the user's logs. All values come from the digest in the
request — do not invent numbers.

- **Session**: one agent conversation, identified locally by `conversation_id`/`chat_session_id`.
  Summaries carry duration, model, token counts, and counts of LLM vs tool calls.
- **Interaction / span**: one recorded operation. `operation` is one of `chat` (an LLM turn),
  `execute_tool` (a tool call), `execute_hook` (a hook), or `invoke_agent` (an agent invocation).
- **Agent mode**: `default`, `ask`, `edit`, `agent`, or `custom` (any user-defined mode collapses to
  `custom`).
- **Tokens**: `inputTokens`, `outputTokens`, `cachedTokens`. Cached input tokens are reused prompt
  context and are usually cheaper. "Total tokens" = input + output.
- **AIU (Copilot Usage)**: GitHub's billed premium-request unit. Stored as integer nano-AIU
  (1 AIU = 1e9 nano). It is the authoritative cost figure when present.
- **Lines of code / docs (LoC / LoD)**: lines the agent wrote to (or removed from) source vs
  documentation files, classified by file extension.
- **Deviation**: a locally-detected mismatch against an expected workflow — `SequenceDeviation`,
  `MissingSteps`, `TimeoutExceeded`, or `ToolUsageAnomaly` (>50% failures over ≥3 interactions).
- **Repository**: a sanitized `https://host/owner/repo` string, or `unknown` when it couldn't be
  resolved.
- **Errors**: spans with an error status (`status_code = 2`).

When asked to summarize, cover: overall activity (sessions, interactions, repos), busiest repositories,
model usage, token/AIU spend, error or deviation hotspots, and 1–3 concrete suggestions.
