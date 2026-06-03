using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services.Analytics;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Verifies <see cref="FallbackAnalyticsService"/> serves the primary result when non-empty and
/// falls back to the legacy source when the primary result is empty.
/// </summary>
public sealed class FallbackAnalyticsServiceTests
{
    /// <summary>Configurable fake that records whether it was invoked.</summary>
    private sealed class FakeAnalyticsService : IAnalyticsService
    {
        private readonly DashboardMetrics _metrics;
        private readonly IReadOnlyList<RepositoryActivitySummary> _repos;
        private readonly IReadOnlyList<DeveloperActivitySummary> _devs;
        private readonly IReadOnlyList<NamedValue> _models;

        public bool DashboardInvoked { get; private set; }
        public bool RepositoryInvoked { get; private set; }
        public bool DeveloperInvoked { get; private set; }
        public bool ModelInvoked { get; private set; }

        public FakeAnalyticsService(
            DashboardMetrics? metrics = null,
            IReadOnlyList<RepositoryActivitySummary>? repos = null,
            IReadOnlyList<DeveloperActivitySummary>? devs = null,
            IReadOnlyList<NamedValue>? models = null)
        {
            _metrics = metrics ?? new DashboardMetrics();
            _repos = repos ?? [];
            _devs = devs ?? [];
            _models = models ?? [];
        }

        public Task<DashboardMetrics> GetDashboardMetricsAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
        {
            DashboardInvoked = true;
            return Task.FromResult(_metrics);
        }

        public Task<IReadOnlyList<RepositoryActivitySummary>> GetRepositoryActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
        {
            RepositoryInvoked = true;
            return Task.FromResult(_repos);
        }

        public Task<IReadOnlyList<DeveloperActivitySummary>> GetDeveloperActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
        {
            DeveloperInvoked = true;
            return Task.FromResult(_devs);
        }

        public Task<IReadOnlyList<NamedValue>> GetModelUsageAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
        {
            ModelInvoked = true;
            return Task.FromResult(_models);
        }
    }

    private static RepositoryActivitySummary SampleRepo() => new() { Repository = "https://github.com/x/y", Requests = 5 };

    [Fact]
    public async Task EmptyPrimary_InvokesLegacyFallback()
    {
        var primary = new FakeAnalyticsService(); // all empty
        var legacy = new FakeAnalyticsService(
            metrics: new DashboardMetrics { TotalRequests = 99 },
            repos: [SampleRepo()]);

        var service = new FallbackAnalyticsService(primary, legacy);

        var metrics = await service.GetDashboardMetricsAsync(TimeSpan.FromHours(24));
        Assert.Equal(99, metrics.TotalRequests);
        Assert.True(legacy.DashboardInvoked);

        var repos = await service.GetRepositoryActivityAsync(TimeSpan.FromHours(24));
        Assert.Single(repos);
        Assert.True(legacy.RepositoryInvoked);
    }

    [Fact]
    public async Task NonEmptyPrimary_DoesNotInvokeLegacy()
    {
        var primary = new FakeAnalyticsService(
            metrics: new DashboardMetrics { TotalRequests = 7 },
            repos: [SampleRepo()]);
        var legacy = new FakeAnalyticsService(metrics: new DashboardMetrics { TotalRequests = 99 });

        var service = new FallbackAnalyticsService(primary, legacy);

        var metrics = await service.GetDashboardMetricsAsync(TimeSpan.FromHours(24));
        Assert.Equal(7, metrics.TotalRequests);
        Assert.False(legacy.DashboardInvoked);

        var repos = await service.GetRepositoryActivityAsync(TimeSpan.FromHours(24));
        Assert.Single(repos);
        Assert.False(legacy.RepositoryInvoked);
    }
}
