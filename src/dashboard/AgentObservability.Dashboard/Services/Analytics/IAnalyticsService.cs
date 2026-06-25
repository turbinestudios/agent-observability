using AgentObservability.Dashboard.Models;

namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Org-level analytics for the four dashboard pages (Overview, Repository, Developer
/// Activity, LLM Analytics), served from the Azure Table Storage aggregate store.
/// </summary>
public interface IAnalyticsService
{
    Task<DashboardMetrics> GetDashboardMetricsAsync(TimeSpan lookback, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<RepositoryActivitySummary>> GetRepositoryActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<DeveloperActivitySummary>> GetDeveloperActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<NamedValue>> GetModelUsageAsync(TimeSpan lookback, CancellationToken cancellationToken = default);
}
