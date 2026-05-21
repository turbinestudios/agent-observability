namespace AgentObservability.Dashboard.Models;

public sealed class SessionInteraction
{
    public required DateTimeOffset Timestamp { get; init; }

    public required string AgentMode { get; init; }

    public required string ToolName { get; init; }

    public required string UserRequest { get; init; }

    public required string Model { get; init; }

    public double DurationMs { get; init; }

    public bool Success { get; init; }
}
