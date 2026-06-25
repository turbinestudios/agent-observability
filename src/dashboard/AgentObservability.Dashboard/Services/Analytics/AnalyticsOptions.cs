namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Configuration for aggregate analytics ('Analytics' section). Bound from appsettings.
/// </summary>
public sealed class AnalyticsOptions
{
    public const string SectionName = "Analytics";

    /// <summary>
    /// Org partition to read aggregate buckets for. Null/empty => ALL orgs (cross-partition).
    /// </summary>
    public string? OrgId { get; set; }
}
