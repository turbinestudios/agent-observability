# Workflow DSL (`agentObservability.workflows`)

The local deviation detector checks each repository's agent sessions against expected workflows.
The setting value is a JSON **array** of per-repository entries.

When generating workflows, emit ONE fenced ` ```ao-workflows ` block containing that array (the value
of `agentObservability.workflows`). Use the exact `repository` strings and observed agent/tool names
from the telemetry digest in the request — never invent them.

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
        "triggerPredicate": { "operation": "chat" },
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
  - `triggerPredicate`: optional metadata filter scoping which interactions count. Fields (all optional,
    string match is case-insensitive): `operation` (`chat` | `execute_tool` | `execute_hook` |
    `invoke_agent`), `agentName`, `agentMode` (`default` | `ask` | `edit` | `agent`), `model`,
    `toolName`, `success` (boolean).
  - `steps`: optional ordered structured steps; when present, supersedes `expectedSequence` for sequence
    checks. Each step: `{ "name": string, "predicate": <metadata predicate>, "contentPredicate"?: {…} }`.

## Notes
- Keep it metadata-only. A `contentPredicate` inspects raw local-only span text and is rarely needed;
  prefer plain `predicate` fields. If you use one, `attribute` must be from the allowed set
  (e.g. `copilot_chat.user_request`, `gen_ai.tool.call.arguments`) and use `contains` (preferred) over
  `matches`; complex regexes are rejected.
- Malformed entries are silently skipped by the parser, so emit clean JSON.
