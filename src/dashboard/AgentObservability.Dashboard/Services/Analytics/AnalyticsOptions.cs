namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Which analytics backend serves the four migrated org-level pages.
/// </summary>
public enum AnalyticsSource
{
    /// <summary>Aggregate-backed store (Phase 8 default). Reproduces the four outputs from buckets.</summary>
    Aggregate,

    /// <summary>Legacy raw Log Analytics queries (rollback path; requires a workspace id).</summary>
    Legacy,
}

/// <summary>
/// Configuration for analytics source selection ('Analytics' section). Bound from appsettings.
/// </summary>
public sealed class AnalyticsOptions
{
    public const string SectionName = "Analytics";

    /// <summary>Source backend for the four migrated outputs. Default <see cref="AnalyticsSource.Aggregate"/>.</summary>
    public AnalyticsSource Source { get; set; } = AnalyticsSource.Aggregate;

    /// <summary>
    /// Org partition to read aggregate buckets for. Null/empty => ALL orgs (cross-partition).
    /// </summary>
    public string? OrgId { get; set; }

    /// <summary>
    /// When true and the aggregate result is empty, fall back to the legacy Log Analytics source.
    /// Default false. Only meaningful when <see cref="Source"/> is <see cref="AnalyticsSource.Aggregate"/>.
    /// </summary>
    public bool FallbackToLegacyWhenEmpty { get; set; }
}
