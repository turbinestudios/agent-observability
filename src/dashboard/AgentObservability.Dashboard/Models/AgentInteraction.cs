namespace AgentObservability.Dashboard.Models;

public sealed class AgentInteraction
{
    public required DateTimeOffset Timestamp { get; init; }

    public required string Repository { get; init; }

    public required string Agent { get; init; }

    public required string ToolName { get; init; }

    public required string Model { get; init; }

    public double DurationMs { get; init; }

    public bool Success { get; init; }
}