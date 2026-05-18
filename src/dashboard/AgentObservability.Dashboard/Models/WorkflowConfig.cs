namespace AgentObservability.Dashboard.Models;

public sealed class WorkflowConfig
{
    public required string Repository { get; init; }

    public required IReadOnlyList<WorkflowDefinition> Workflows { get; init; }

    public static IReadOnlyList<WorkflowConfig> Examples { get; } =
    [
        new WorkflowConfig
        {
            Repository = "Turbine/agent-observability",
            Workflows =
            [
                new WorkflowDefinition
                {
                    Name = "feature-development",
                    ExpectedSequence = ["planner", "coder", "reviewer"],
                    MaxDuration = TimeSpan.FromMinutes(30),
                    SequenceDeviationAlert = true,
                    TimeoutExceededAlert = true,
                    ToolUsageAnomalyAlert = true
                }
            ]
        }
    ];
}

public sealed class WorkflowDefinition
{
    public required string Name { get; init; }

    public required IReadOnlyList<string> ExpectedSequence { get; init; }

    public required TimeSpan MaxDuration { get; init; }

    public bool SequenceDeviationAlert { get; init; }

    public bool TimeoutExceededAlert { get; init; }

    public bool ToolUsageAnomalyAlert { get; init; }
}