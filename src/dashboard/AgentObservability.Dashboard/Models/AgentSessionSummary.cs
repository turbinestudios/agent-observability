namespace AgentObservability.Dashboard.Models;

public sealed class AgentSessionSummary
{
    public required string SessionId { get; init; }

    public required string User { get; init; }

    public required DateTimeOffset StartTime { get; init; }

    public required DateTimeOffset EndTime { get; init; }

    public int RequestCount { get; init; }

    public required string AgentModes { get; init; }
}
