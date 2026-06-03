using AgentObservability.Dashboard.Models;

namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Dual-read wrapper: serves from the primary (aggregate) <see cref="IAnalyticsService"/> and, when
/// the primary result is empty, falls back to the legacy source. Lets an org with no aggregate data
/// yet keep rendering from raw Log Analytics during the Phase 8 migration. Wired only when
/// <c>Analytics:FallbackToLegacyWhenEmpty</c> is true.
/// </summary>
public sealed class FallbackAnalyticsService : IAnalyticsService
{
    private readonly IAnalyticsService _primary;
    private readonly IAnalyticsService _fallback;

    public FallbackAnalyticsService(IAnalyticsService primary, IAnalyticsService fallback)
    {
        _primary = primary;
        _fallback = fallback;
    }

    public async Task<DashboardMetrics> GetDashboardMetricsAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        var result = await _primary.GetDashboardMetricsAsync(lookback, cancellationToken).ConfigureAwait(false);
        return result.TotalRequests > 0
            ? result
            : await _fallback.GetDashboardMetricsAsync(lookback, cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<RepositoryActivitySummary>> GetRepositoryActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        var result = await _primary.GetRepositoryActivityAsync(lookback, cancellationToken).ConfigureAwait(false);
        return result.Count > 0
            ? result
            : await _fallback.GetRepositoryActivityAsync(lookback, cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<DeveloperActivitySummary>> GetDeveloperActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        var result = await _primary.GetDeveloperActivityAsync(lookback, cancellationToken).ConfigureAwait(false);
        return result.Count > 0
            ? result
            : await _fallback.GetDeveloperActivityAsync(lookback, cancellationToken).ConfigureAwait(false);
    }

    public async Task<IReadOnlyList<NamedValue>> GetModelUsageAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        var result = await _primary.GetModelUsageAsync(lookback, cancellationToken).ConfigureAwait(false);
        return result.Count > 0
            ? result
            : await _fallback.GetModelUsageAsync(lookback, cancellationToken).ConfigureAwait(false);
    }
}
