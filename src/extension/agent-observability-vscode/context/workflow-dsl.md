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

## Field reference
- `repository` (required): sanitized repo URL, e.g. `https://github.com/org/repo`.
- `workflows` (required): array of workflow definitions:
  - `name` (required): human-readable, e.g. `feature-development`.
  - `expectedSequence`: ordered agent names. When present, enables sequence + missing-step checks.
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
never the trigger. If the context files expose no real discriminator, emit ONE repo-wide workflow rather
than a vague trigger.

## Notes
- Prefer metadata `predicate` fields. A step `contentPredicate` inspects raw local-only span text; its
  main legitimate use is asserting a custom mode via `copilot_chat.mode_name`. If you use one, `attribute`
  must be from the allowed set (e.g. `copilot_chat.user_request`, `copilot_chat.mode_name`,
  `gen_ai.tool.call.arguments`) and use `contains` (preferred) over `matches`; complex regexes are rejected.
- A `contentPredicate` only refines a step within the triggered scope — it cannot gate whether the
  workflow applies. Applicability is decided solely by the metadata `triggerPredicate`.
- Malformed entries are silently skipped by the parser, so emit clean JSON.
