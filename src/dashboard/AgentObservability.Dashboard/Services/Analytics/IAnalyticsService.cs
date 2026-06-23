using AgentObservability.Dashboard.Models;

namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Org-level analytics for the four migrated dashboard pages (Overview, Repository, Developer
/// Activity, LLM Analytics). Mirrors the equivalent <c>LogAnalyticsService</c> signatures so the
/// pages can switch source via DI without changing output shapes.
/// </summary>
public interface IAnalyticsService
{
    Task<DashboardMetrics> GetDashboardMetricsAsync(TimeSpan lookback, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<RepositoryActivitySummary>> GetRepositoryActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<DeveloperActivitySummary>> GetDeveloperActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default);

    Task<IReadOnlyList<NamedValue>> GetModelUsageAsync(TimeSpan lookback, CancellationToken cancellationToken = default);
}
