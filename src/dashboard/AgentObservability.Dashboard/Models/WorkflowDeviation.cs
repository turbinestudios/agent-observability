namespace AgentObservability.Dashboard.Models;

/// <summary>
/// Represents a detected workflow deviation that may trigger an alert.
/// </summary>
public sealed class WorkflowDeviation
{
    public required string Repository { get; init; }

    public required string WorkflowName { get; init; }

    public required DeviationType Type { get; init; }

    public required string Description { get; init; }

    public required DateTimeOffset DetectedAt { get; init; }

    public IReadOnlyList<string> ActualSequence { get; init; } = [];

    public IReadOnlyList<string> ExpectedSequence { get; init; } = [];

    public TimeSpan? ActualDuration { get; init; }

    public TimeSpan? MaxDuration { get; init; }

    public string? SessionId { get; init; }
}

public enum DeviationType
{
    SequenceDeviation,
    TimeoutExceeded,
    MissingSteps,
    ToolUsageAnomaly
}

/// <summary>
/// Configuration for the alert engine background service.
/// </summary>
public sealed class AlertEngineOptions
{
    public const string SectionName = "AlertEngine";

    /// <summary>
    /// How often the alert engine checks for deviations.
    /// </summary>
    public TimeSpan PollingInterval { get; init; } = TimeSpan.FromMinutes(5);

    /// <summary>
    /// How far back to look for interactions on each poll cycle.
    /// </summary>
    public TimeSpan LookbackWindow { get; init; } = TimeSpan.FromMinutes(10);

    /// <summary>
    /// Whether the alert engine is enabled.
    /// </summary>
    public bool Enabled { get; init; } = true;

    /// <summary>
    /// Microsoft Teams webhook URL for sending alerts.
    /// </summary>
    public string? TeamsWebhookUrl { get; init; }
}
