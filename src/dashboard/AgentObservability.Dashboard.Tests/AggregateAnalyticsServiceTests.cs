using AgentObservability.Dashboard.Models.Ingestion;
using AgentObservability.Dashboard.Services.Analytics;
using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.Extensions.Options;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Verifies <see cref="AggregateAnalyticsService"/> reproduces the four legacy org-level outputs
/// from seeded in-memory buckets (no live Azure), applying the additive-vs-distinct rules and the
/// histogram-based p95 approximation.
/// </summary>
public sealed class AggregateAnalyticsServiceTests
{
    private const string OrgId = "org-test";
    private const string DevA = "dev_00000000000000000000000000000a01";
    private const string DevB = "dev_00000000000000000000000000000b02";
    private const string RepoA = "https://github.com/turbinestudios/alpha";
    private const string RepoB = "https://github.com/turbinestudios/beta";
    private const string ModelX = "gpt-4.1";
    private const string ModelY = "claude-opus";

    // Deterministic "now". Buckets are placed within 24h of this instant.
    private static readonly DateTimeOffset Now = new(2026, 6, 2, 12, 0, 0, TimeSpan.Zero);

    private static readonly double[] Bounds = [100, 250, 500, 1000, 2000, 5000, 10000, 30000];

    private static AggregateAnalyticsService BuildService(InMemoryAggregateStore store, string? orgId = OrgId)
    {
        var options = Options.Create(new AnalyticsOptions { OrgId = orgId });
        return new AggregateAnalyticsService(store, options, new FixedTimeProvider(Now));
    }

    /// <summary>Minimal deterministic <see cref="TimeProvider"/> (avoids a test-only package dependency).</summary>
    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    /// <summary>Builds a single bucket with explicit measures and a uniform-ish histogram.</summary>
    private static AggregateBucket Bucket(
        string rowKey,
        DateTimeOffset bucketStart,
        string repository,
        string model,
        int interactionCount,
        double durationMsSum,
        long inputTokens = 0,
        long outputTokens = 0,
        long? lastActivityAtMs = null,
        IReadOnlyList<long>? counts = null) => new()
    {
        RowKey = rowKey,
        BucketStart = bucketStart,
        BucketDurationSeconds = 1800,
        Repository = repository,
        Model = model,
        AgentMode = "agent",
        Operation = "chat",
        InteractionCount = interactionCount,
        SuccessCount = interactionCount,
        ErrorCount = 0,
        InputTokens = inputTokens,
        OutputTokens = outputTokens,
        CachedTokens = 0,
        DurationMsSum = durationMsSum,
        LatencyHistogram = new LatencyHistogram
        {
            BoundsMs = Bounds,
            Counts = counts ?? [0, 0, 0, 0, 0, 0, 0, 0, 0],
        },
        DistinctSessionCount = 1,
        LastActivityAtMs = lastActivityAtMs,
    };

    private static AggregateBatch Batch(string developerId, params AggregateBucket[] buckets) => new()
    {
        SchemaVersion = "1.0",
        BatchId = $"batch-{developerId}-{Guid.NewGuid():N}",
        GeneratedAt = Now,
        ToolVersion = "1.4.2",
        PseudonymousDeveloperId = developerId,
        Window = new AggregateWindow { Start = Now.AddHours(-24), End = Now },
        Buckets = buckets,
    };

    /// <summary>
    /// Seeds: 2 repos, 2 developers, 2 models, multiple 30-min bins. Returns the populated store.
    /// Bin A = Now-2h (bin start), Bin B = Now-90m.
    /// </summary>
    private static async Task<InMemoryAggregateStore> SeedAsync()
    {
        var store = new InMemoryAggregateStore();

        var binA = new DateTimeOffset(2026, 6, 2, 10, 0, 0, TimeSpan.Zero); // Now - 2h
        var binB = new DateTimeOffset(2026, 6, 2, 10, 30, 0, TimeSpan.Zero); // Now - 90m

        // Developer A.
        await store.UpsertBucketsAsync(OrgId, Batch(DevA,
            // RepoA / ModelX, bin A: 10 reqs, 2000ms total, tokens 100/50.
            Bucket("a1", binA, RepoA, ModelX, interactionCount: 10, durationMsSum: 2000, inputTokens: 100, outputTokens: 50, lastActivityAtMs: 1_000),
            // RepoA / ModelX, bin B: 5 reqs (same dev+repo => merges into the developer/repo rollup).
            Bucket("a2", binB, RepoA, ModelX, interactionCount: 5, durationMsSum: 1000, inputTokens: 20, outputTokens: 10, lastActivityAtMs: 5_000),
            // RepoB / ModelY, bin A: 4 reqs.
            Bucket("a3", binA, RepoB, ModelY, interactionCount: 4, durationMsSum: 800, inputTokens: 7, outputTokens: 3)));

        // Developer B.
        await store.UpsertBucketsAsync(OrgId, Batch(DevB,
            // RepoA / ModelY, bin B: 6 reqs.
            Bucket("b1", binB, RepoA, ModelY, interactionCount: 6, durationMsSum: 1200, inputTokens: 60, outputTokens: 40),
            // "unknown" repo, bin A: 3 reqs (counts toward totals, excluded from repo/active-repo).
            Bucket("b2", binA, "unknown", ModelX, interactionCount: 3, durationMsSum: 300)));

        return store;
    }

    [Fact]
    public async Task DashboardMetrics_ComputesTotalsAverageDistinctsVolumeAndModelBreakdown()
    {
        var store = await SeedAsync();
        var service = BuildService(store);

        var metrics = await service.GetDashboardMetricsAsync(TimeSpan.FromHours(24));

        // TotalRequests = 10+5+4+6 = 25. The 3 unknown-repo requests (b2) are EXCLUDED from the
        // overview scalars, matching the legacy overview query's `where Repository != "unknown"`.
        Assert.Equal(25, metrics.TotalRequests);

        // AverageLatencyMs = (2000+1000+800+1200) / 25 = 5000 / 25 = 200 (b2's 300ms/3 reqs excluded).
        Assert.Equal(200d, metrics.AverageLatencyMs, 6);

        // ActiveRepositories: distinct repo excluding "unknown" => RepoA, RepoB = 2.
        Assert.Equal(2, metrics.ActiveRepositories);

        // ActiveDevelopers: distinct pseudonymous id => DevA, DevB = 2.
        Assert.Equal(2, metrics.ActiveDevelopers);

        // RequestVolume: per 30-min bin, ascending. Bin A (10:00) = 10+4+3 = 17; Bin B (10:30) = 5+6 = 11.
        Assert.Equal(2, metrics.RequestVolume.Count);
        Assert.Equal(new DateTimeOffset(2026, 6, 2, 10, 0, 0, TimeSpan.Zero), metrics.RequestVolume[0].Timestamp);
        Assert.Equal(17, metrics.RequestVolume[0].Value);
        Assert.Equal(new DateTimeOffset(2026, 6, 2, 10, 30, 0, TimeSpan.Zero), metrics.RequestVolume[1].Timestamp);
        Assert.Equal(11, metrics.RequestVolume[1].Value);

        // ModelBreakdown desc: ModelX = 10+5+3 = 18; ModelY = 4+6 = 10.
        Assert.Equal(2, metrics.ModelBreakdown.Count);
        Assert.Equal(ModelX, metrics.ModelBreakdown[0].Label);
        Assert.Equal(18, metrics.ModelBreakdown[0].Value);
        Assert.Equal(ModelY, metrics.ModelBreakdown[1].Label);
        Assert.Equal(10, metrics.ModelBreakdown[1].Value);
    }

    [Fact]
    public async Task DashboardMetrics_P95_CrossesExpectedHistogramBound()
    {
        var store = new InMemoryAggregateStore();

        // Craft two histograms that merge to: [0,0,90,0,0,5,5,0,0] (total 100).
        // Cumulative: bound 500 (index 2) -> 90 < 95; bound 5000 (index 5) -> 95 >= 95 => p95 = 5000.
        await store.UpsertBucketsAsync(OrgId, Batch(DevA,
            Bucket("h1", Now.AddHours(-1), RepoA, ModelX, interactionCount: 95, durationMsSum: 1,
                counts: [0, 0, 90, 0, 0, 5, 0, 0, 0]),
            Bucket("h2", Now.AddHours(-1).AddMinutes(1), RepoA, ModelX, interactionCount: 5, durationMsSum: 1,
                counts: [0, 0, 0, 0, 0, 0, 5, 0, 0])));

        var service = BuildService(store);
        var metrics = await service.GetDashboardMetricsAsync(TimeSpan.FromHours(24));

        Assert.Equal(5000d, metrics.P95LatencyMs);
    }

    [Fact]
    public async Task DashboardMetrics_P95_OverflowBucketReportsTopBound()
    {
        var store = new InMemoryAggregateStore();

        // All mass in the +Inf overflow bucket (index 8) => p95 = top bound 30000.
        await store.UpsertBucketsAsync(OrgId, Batch(DevA,
            Bucket("o1", Now.AddHours(-1), RepoA, ModelX, interactionCount: 10, durationMsSum: 1,
                counts: [0, 0, 0, 0, 0, 0, 0, 0, 10])));

        var service = BuildService(store);
        var metrics = await service.GetDashboardMetricsAsync(TimeSpan.FromHours(24));

        Assert.Equal(30000d, metrics.P95LatencyMs);
    }

    [Fact]
    public async Task RepositoryActivity_RollsUpPerRepoExcludingUnknown()
    {
        var store = await SeedAsync();
        var service = BuildService(store);

        var repos = await service.GetRepositoryActivityAsync(TimeSpan.FromHours(24));

        // Only RepoA and RepoB (unknown excluded), ordered by Requests desc.
        Assert.Equal(2, repos.Count);

        // RepoA: 10+5+6 = 21 reqs; devs DevA, DevB = 2; models ModelX, ModelY = 2; dur (2000+1000+1200)/21.
        var repoA = repos[0];
        Assert.Equal(RepoA, repoA.Repository);
        Assert.Equal(21, repoA.Requests);
        Assert.Equal(2, repoA.ActiveDevelopers);
        Assert.Equal(2, repoA.UniqueModels);
        Assert.Equal(4200d / 21d, repoA.AverageLatencyMs, 6);

        // RepoB: 4 reqs; dev DevA = 1; model ModelY = 1; dur 800/4 = 200.
        var repoB = repos[1];
        Assert.Equal(RepoB, repoB.Repository);
        Assert.Equal(4, repoB.Requests);
        Assert.Equal(1, repoB.ActiveDevelopers);
        Assert.Equal(1, repoB.UniqueModels);
        Assert.Equal(200d, repoB.AverageLatencyMs);
    }

    [Fact]
    public async Task DeveloperActivity_RollsUpPerDeveloperRepoWithLastSeenFromLastActivity()
    {
        var store = await SeedAsync();
        var service = BuildService(store);

        var devs = await service.GetDeveloperActivityAsync(TimeSpan.FromHours(24));

        // (DevA, RepoA): 10+5 = 15 reqs; UniqueModels = 1 (ModelX); LastSeen = max(1000, 5000) ms.
        var devARepoA = devs.Single(d => d.Developer == DevA && d.Repository == RepoA);
        Assert.Equal(15, devARepoA.Requests);
        Assert.Equal(1, devARepoA.UniqueModels);
        Assert.Equal(DateTimeOffset.FromUnixTimeMilliseconds(5_000), devARepoA.LastSeen);
        Assert.Equal(3000d / 15d, devARepoA.AverageLatencyMs, 6);

        // (DevA, RepoB): 4 reqs; no LastActivityAtMs => fall back to max BucketStart (bin A 10:00).
        var devARepoB = devs.Single(d => d.Developer == DevA && d.Repository == RepoB);
        Assert.Equal(4, devARepoB.Requests);
        Assert.Equal(new DateTimeOffset(2026, 6, 2, 10, 0, 0, TimeSpan.Zero), devARepoB.LastSeen);

        // (DevB, RepoA) and (DevB, unknown) both present.
        Assert.Contains(devs, d => d.Developer == DevB && d.Repository == RepoA && d.Requests == 6);
        Assert.Contains(devs, d => d.Developer == DevB && d.Repository == "unknown" && d.Requests == 3);

        // Ordered by Requests desc.
        for (var i = 1; i < devs.Count; i++)
        {
            Assert.True(devs[i - 1].Requests >= devs[i].Requests);
        }
    }

    [Fact]
    public async Task ModelUsage_SumsRequestsAndTokenSecondaryValue()
    {
        var store = await SeedAsync();
        var service = BuildService(store);

        var models = await service.GetModelUsageAsync(TimeSpan.FromHours(24));

        Assert.Equal(2, models.Count);

        // ModelX: reqs 10+5+3 = 18; tokens (100+50)+(20+10)+(0+0) = 180.
        var modelX = models.Single(m => m.Label == ModelX);
        Assert.Equal(18, modelX.Value);
        Assert.Equal(180d, modelX.SecondaryValue);

        // ModelY: reqs 4+6 = 10; tokens (7+3)+(60+40) = 110.
        var modelY = models.Single(m => m.Label == ModelY);
        Assert.Equal(10, modelY.Value);
        Assert.Equal(110d, modelY.SecondaryValue);

        // Descending by Requests.
        Assert.Equal(ModelX, models[0].Label);
    }

    [Fact]
    public async Task NoData_ReturnsZeroedMetricsAndEmptyLists()
    {
        var store = new InMemoryAggregateStore();
        var service = BuildService(store);

        var metrics = await service.GetDashboardMetricsAsync(TimeSpan.FromHours(24));
        Assert.Equal(0, metrics.TotalRequests);
        Assert.Equal(0, metrics.AverageLatencyMs);
        Assert.Equal(0, metrics.P95LatencyMs);
        Assert.Equal(0, metrics.ActiveRepositories);
        Assert.Equal(0, metrics.ActiveDevelopers);
        Assert.Empty(metrics.RequestVolume);
        Assert.Empty(metrics.ModelBreakdown);

        Assert.Empty(await service.GetRepositoryActivityAsync(TimeSpan.FromHours(24)));
        Assert.Empty(await service.GetDeveloperActivityAsync(TimeSpan.FromHours(24)));
        Assert.Empty(await service.GetModelUsageAsync(TimeSpan.FromHours(24)));
    }

    [Fact]
    public async Task Lookback_ExcludesBucketsOlderThanWindow()
    {
        var store = await SeedAsync();
        var service = BuildService(store);

        // A 1-hour lookback (Now-1h .. Now) excludes all seeded buckets (oldest bins are 90m-2h old).
        var metrics = await service.GetDashboardMetricsAsync(TimeSpan.FromHours(1));

        Assert.Equal(0, metrics.TotalRequests);
    }
}
