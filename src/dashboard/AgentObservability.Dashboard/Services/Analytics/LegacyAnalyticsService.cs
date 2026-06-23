using AgentObservability.Dashboard.Models;

namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Legacy <see cref="IAnalyticsService"/> that delegates to the raw Log Analytics queries in
/// <see cref="LogAnalyticsService"/>. Used as the rollback source (Source=Legacy) and as the
/// fallback target for <see cref="FallbackAnalyticsService"/>. Requires a configured workspace id.
/// </summary>
public sealed class LegacyAnalyticsService : IAnalyticsService
{
    private readonly LogAnalyticsService _logAnalytics;

    public LegacyAnalyticsService(LogAnalyticsService logAnalytics)
    {
        _logAnalytics = logAnalytics;
    }

    public Task<DashboardMetrics> GetDashboardMetricsAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
        => _logAnalytics.GetDashboardMetricsAsync(lookback, cancellationToken);

    public Task<IReadOnlyList<RepositoryActivitySummary>> GetRepositoryActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
        => _logAnalytics.GetRepositoryActivityAsync(lookback, cancellationToken);

    public Task<IReadOnlyList<DeveloperActivitySummary>> GetDeveloperActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
        => _logAnalytics.GetDeveloperActivityAsync(lookback, cancellationToken);

    public Task<IReadOnlyList<NamedValue>> GetModelUsageAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
        => _logAnalytics.GetModelUsageAsync(lookback, cancellationToken);
}
