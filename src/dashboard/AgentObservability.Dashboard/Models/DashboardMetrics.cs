namespace AgentObservability.Dashboard.Models;

public sealed class DashboardMetrics
{
    public int TotalRequests { get; init; }

    public double AverageLatencyMs { get; init; }

    public double P95LatencyMs { get; init; }

    public int ActiveRepositories { get; init; }

    public int ActiveDevelopers { get; init; }

    public IReadOnlyList<TimeSeriesPoint> RequestVolume { get; init; } = [];

    public IReadOnlyList<NamedValue> ModelBreakdown { get; init; } = [];
}

public sealed class TimeSeriesPoint
{
    public required DateTimeOffset Timestamp { get; init; }

    public required string Label { get; init; }

    public double Value { get; init; }
}

public sealed class NamedValue
{
    public required string Label { get; init; }

    public double Value { get; init; }

    public double SecondaryValue { get; init; }
}

public sealed class DeveloperActivitySummary
{
    public required string Developer { get; init; }

    public required string Repository { get; init; }

    public int Requests { get; init; }

    public double AverageLatencyMs { get; init; }

    public int UniqueModels { get; init; }

    public required DateTimeOffset LastSeen { get; init; }
}

public sealed class RepositoryActivitySummary
{
    public required string Repository { get; init; }

    public int Requests { get; init; }

    public int ActiveDevelopers { get; init; }

    public double AverageLatencyMs { get; init; }

    public int UniqueModels { get; init; }
}