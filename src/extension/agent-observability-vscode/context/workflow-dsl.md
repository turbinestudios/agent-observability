# Workflow DSL (`agentObservability.workflows`)

The local deviation detector checks each repository's agent sessions against expected workflows.
The setting value is a JSON **array** of per-repository entries.

When generating workflows, emit ONE fenced ` ```ao-workflows ` block containing that array (the value
of `agentObservability.workflows`). Use the exact `repository` string and the agent/tool names that
appear in the project context files digest in the request — never invent them.

## Shape
```ao-workflows
[
  {
    "repository": "https://github.com/org/repo",
    "workflows": [
      {
        "name": "feature-development",
        "expectedSequence": ["planner", "coder"],
        "maxDurationMinutes": 30,
        "sequenceDeviationAlert": true,
        "timeoutExceededAlert": true,
        "toolUsageAnomalyAlert": true,
        "triggerPredicate": { "operation": "invoke_agent" },
        "steps": [
          { "name": "Plan", "predicate": { "agentName": "planner" } },
          { "name": "Implement", "predicate": { "agentName": "coder", "success": true } }
        ]
      }
    ]
  }
]
```

## A custom agent is not one fixed pipeline

A custom agent (or custom chat mode) is a DISPATCHER, not a deterministic pipeline. The same agent runs
different skills/tasks on different invocations, so the agents, tools, and order observed in its sessions
legitimately VARY run to run. Two consequences for generation:

1. **Model the flow, not the agent.** Do not emit one rigid workflow per agent — that flags every run that
   does something else as a false deviation. Model each distinct TASK/FLOW the project defines (often a
   single skill or prompt). One agent exposing several skills should yield SEVERAL narrowly-scoped workflows
   — or none — never one catch-all sequence.
2. **Assert only invariants.** Put in `expectedSequence`/`steps` ONLY actions that occur on EVERY run of that
   flow. The detector reports any declared step a turn did not perform as a missing-step deviation, so an
   optional/conditional step is a false alarm on the runs that skip it. When in doubt, leave it out; if a flow
   has no step that always runs, emit a workflow with NO `expectedSequence`/`steps` (timeout + tool-usage
   checks still apply) rather than guessing an order.

## Field reference
- `repository` (required): sanitized repo URL, e.g. `https://github.com/org/repo`.
- `workflows` (required): array of workflow definitions:
  - `name` (required): human-readable, e.g. `feature-development`.
  - `expectedSequence`: ordered agent names. When present, enables sequence + missing-step checks. Include
    ONLY agents that run on every invocation of this flow — a name that is sometimes absent is reported missing.
  - `maxDurationMinutes`: session duration threshold; defaults to `deviation.maxSessionMinutes`.
  - `sequenceDeviationAlert` / `timeoutExceededAlert` / `toolUsageAnomalyAlert`: booleans, default `true`.
  - `triggerPredicate`: optional metadata filter scoping which interactions count — see "Scope each
    workflow" below. Fields (all optional, string match is case-insensitive): `operation` (`chat` |
    `execute_tool` | `execute_hook` | `invoke_agent`), `agentName`, `agentMode` (`default` | `ask` |
    `edit` | `agent` | `custom` — every custom chat mode collapses to `custom`), `model`, `toolName`,
    `success` (boolean).
  - `steps`: optional ordered structured steps; when present, supersedes `expectedSequence` for sequence
    checks. Each step: `{ "name": string, "predicate": <metadata predicate>, "contentPredicate"?: {…} }`.

## Scope each workflow with a precise `triggerPredicate`

`triggerPredicate` is the ONLY thing that decides whether a workflow applies to a session, and it is
METADATA-ONLY (it cannot read content). Mechanically the detector keeps just the interactions in a
session that match the trigger, then runs every check (sequence, missing-step, timeout, tool-usage)
over that subset. Two rules follow:

1. **Never match everything.** A trigger that (nearly) every session satisfies turns ordinary work into
   false deviations. Do NOT scope by `agentMode` alone, and never leave the trigger empty. Because every
   custom chat mode reports as `agentMode: "custom"`, `agentMode` can never tell one workflow from another.
2. **Never be narrower than the steps.** A step can only match inside the triggered subset, so a trigger
   that filters out a step's agent/tool guarantees that step is reported missing. The trigger must be a
   SUPERSET of every step's predicate.

Pick a discriminator present in this workflow's sessions and absent from the rest:

| Situation | Trigger |
| --- | --- |
| Flow spawns named sub-agents | `{ "operation": "invoke_agent" }` — steps then match each sub-agent's `agentName` |
| A tool only this workflow uses | `{ "toolName": "<tool>" }` |
| The agent file pins a model | `{ "model": "<model id as it appears in telemetry>" }` |
| One spawned sub-agent drives it | `{ "agentName": "<sub-agent>" }` (only if no step needs a different agent) |

The custom mode/agent NAME is not metadata — it lives only in the local-only `copilot_chat.mode_name`
content attribute. To assert "this ran in mode X", use a step `contentPredicate` on `copilot_chat.mode_name`,
never the metadata trigger. If the context files expose no real discriminator, emit ONE repo-wide workflow
rather than a vague trigger.

To separate one skill/task from the OTHERS the same agent can run (the usual case — see "A custom agent is
not one fixed pipeline"), no metadata field distinguishes them, so reach for a `triggerContentPredicate` on
the request intent (below) or a `toolName`/`model` unique to that flow. Without such a discriminator, a
per-skill `expectedSequence` will be reported missing on every run of the agent's other skills.

When relevance is about what the request is ABOUT (intent) rather than metadata, add a
`triggerContentPredicate` — a LOCAL-ONLY content gate on the turn's user request. The workflow then applies
to a turn only when the request content matches (in addition to any metadata `triggerPredicate`):
```json
"triggerContentPredicate": { "attribute": "copilot_chat.user_request", "contains": "migrate the database" }
```
`attribute` must be from the allowed content set (commonly `copilot_chat.user_request`); prefer `contains`.
A content-triggered workflow is evaluated only locally per user-request and never participates in cloud
sync — use it when no metadata signal distinguishes the task.

## Notes
- Prefer metadata `predicate` fields. A step `contentPredicate` inspects raw local-only span text; its
  main legitimate use is asserting a custom mode via `copilot_chat.mode_name`. If you use one, `attribute`
  must be from the allowed set (e.g. `copilot_chat.user_request`, `copilot_chat.mode_name`,
  `gen_ai.tool.call.arguments`) and use `contains` (preferred) over `matches`; complex regexes are rejected.
- A `contentPredicate` only refines a step within the triggered scope — it cannot gate whether the
  workflow applies. Applicability is decided solely by the metadata `triggerPredicate`.
- Malformed entries are silently skipped by the parser, so emit clean JSON.
