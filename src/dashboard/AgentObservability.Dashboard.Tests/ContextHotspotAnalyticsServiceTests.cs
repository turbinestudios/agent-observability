using AgentObservability.Dashboard.Models.Ingestion;
using AgentObservability.Dashboard.Services.Analytics;
using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.Extensions.Options;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Verifies <see cref="ContextHotspotAnalyticsService"/> aggregates context-insight rows into
/// ranked hotspots: misconfigured (high-skip) and high-friction files rank above clean ones, raw
/// signals are summed correctly across buckets/developers, and the repository filter scopes results.
/// </summary>
public sealed class ContextHotspotAnalyticsServiceTests
{
    private const string OrgId = "org-test";
    private const string DevA = "dev_00000000000000000000000000000a01";
    private const string DevB = "dev_00000000000000000000000000000b02";
    private const string RepoA = "https://github.com/turbinestudios/alpha";
    private const string RepoB = "https://github.com/turbinestudios/beta";

    private static readonly DateTimeOffset Now = new(2026, 6, 2, 12, 0, 0, TimeSpan.Zero);
    private static readonly TimeSpan Lookback = TimeSpan.FromDays(14);

    private sealed class FixedTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;
    }

    private static ContextHotspotAnalyticsService BuildService(InMemoryContextInsightStore store, string? orgId = OrgId)
    {
        var options = Options.Create(new AnalyticsOptions { OrgId = orgId });
        return new ContextHotspotAnalyticsService(store, options, new FixedTimeProvider(Now));
    }

    private static ContextFileRow Row(
        string rowKey,
        string contextFile,
        string category,
        string repository,
        int applied,
        int skipped,
        long estTokensMax,
        long estTokensSum,
        int errors,
        int deviations) => new()
    {
        RowKey = rowKey,
        BucketStart = Now.AddHours(-2),
        BucketDurationSeconds = 1800,
        Repository = repository,
        ContextFile = contextFile,
        Category = category,
        AppliedCount = applied,
        SkippedCount = skipped,
        SkipReasonCounts = skipped > 0 ? new SkipReasonCounts { ApplyToNoMatch = skipped } : null,
        EstTokensSum = estTokensSum,
        EstTokensMax = estTokensMax,
        SessionsWithErrorCount = errors,
        SessionsWithDeviationCount = deviations,
        DistinctSessionCount = applied + skipped,
        LastActivityAtMs = Now.AddHours(-2).ToUnixTimeMilliseconds(),
    };

    private static async Task SeedAsync(InMemoryContextInsightStore store, string developerId, params ContextFileRow[] rows)
    {
        var batch = new ContextInsightsBatch
        {
            SchemaVersion = "1.0",
            BatchId = $"batch-{developerId}-{Guid.NewGuid():N}",
            GeneratedAt = Now,
            ToolVersion = "0.1.19",
            PseudonymousDeveloperId = developerId,
            Window = new ContextInsightsWindow { Start = Now.AddHours(-24), End = Now },
            Rows = rows,
        };
        await store.UpsertRowsAsync(OrgId, batch);
    }

    private const string Misconfigured = ".github/instructions/misconfig.instructions.md";
    private const string PopularClean = ".github/copilot-instructions.md";
    private const string Friction = ".github/prompts/friction.prompt.md";

    private static async Task<InMemoryContextInsightStore> SeededStoreAsync()
    {
        var store = new InMemoryContextInsightStore();

        // Repo A: a misconfigured (high-skip) file, a popular clean file, and a high-friction file.
        await SeedAsync(store, DevA,
            Row("m1", Misconfigured, "instruction", RepoA, applied: 1, skipped: 9, estTokensMax: 100, estTokensSum: 100, errors: 0, deviations: 0),
            Row("p1", PopularClean, "instruction", RepoA, applied: 10, skipped: 0, estTokensMax: 100, estTokensSum: 1000, errors: 0, deviations: 0),
            Row("f1", Friction, "prompt", RepoA, applied: 5, skipped: 0, estTokensMax: 100, estTokensSum: 500, errors: 3, deviations: 2));

        // Same friction file applied by a second developer in another bucket (additive + distinct devs).
        await SeedAsync(store, DevB,
            Row("f2", Friction, "prompt", RepoA, applied: 5, skipped: 0, estTokensMax: 100, estTokensSum: 500, errors: 2, deviations: 3));

        // Repo B: an unrelated clean file, plus an 'unknown' repo row that must not appear in the filter list.
        await SeedAsync(store, DevB,
            Row("b1", "AGENTS.md", "agent", RepoB, applied: 3, skipped: 0, estTokensMax: 100, estTokensSum: 300, errors: 0, deviations: 0),
            Row("u1", PopularClean, "instruction", "unknown", applied: 2, skipped: 0, estTokensMax: 100, estTokensSum: 200, errors: 0, deviations: 0));

        return store;
    }

    [Fact]
    public async Task Hotspots_RankMisconfiguredAndFrictionAboveClean()
    {
        var store = await SeededStoreAsync();
        var service = BuildService(store);

        var hotspots = await service.GetHotspotsAsync(RepoA, Lookback);

        Assert.Equal(3, hotspots.Count);
        // Clean, popular-but-healthy file must not be the top hotspot.
        Assert.NotEqual(PopularClean, hotspots[0].ContextFile);
        // The two problem files outrank the clean one.
        var cleanRank = hotspots.ToList().FindIndex(h => h.ContextFile == PopularClean);
        var misconfigRank = hotspots.ToList().FindIndex(h => h.ContextFile == Misconfigured);
        var frictionRank = hotspots.ToList().FindIndex(h => h.ContextFile == Friction);
        Assert.True(misconfigRank < cleanRank);
        Assert.True(frictionRank < cleanRank);
        // Scores are descending.
        Assert.True(hotspots[0].HotspotScore >= hotspots[1].HotspotScore);
        Assert.True(hotspots[1].HotspotScore >= hotspots[2].HotspotScore);
    }

    [Fact]
    public async Task FrictionFile_AggregatesSignalsAndDistinctDevelopersAcrossBuckets()
    {
        var store = await SeededStoreAsync();
        var service = BuildService(store);

        var hotspots = await service.GetHotspotsAsync(RepoA, Lookback);
        var friction = hotspots.Single(h => h.ContextFile == Friction);

        Assert.Equal(10, friction.AppliedCount);                 // 5 + 5
        Assert.Equal(5, friction.SessionsWithErrorCount);        // 3 + 2
        Assert.Equal(5, friction.SessionsWithDeviationCount);    // 2 + 3
        Assert.Equal(2, friction.DistinctDeveloperCount);        // DevA + DevB
        Assert.Equal(100, friction.MaxEstTokens);
        Assert.Equal(100, friction.AverageEstTokens);            // 1000 / 10
    }

    [Fact]
    public async Task MisconfiguredFile_HasHighSkipRateAndScore()
    {
        var store = await SeededStoreAsync();
        var service = BuildService(store);

        var hotspots = await service.GetHotspotsAsync(RepoA, Lookback);
        var misconfig = hotspots.Single(h => h.ContextFile == Misconfigured);

        Assert.Equal(9, misconfig.SkippedCount);
        Assert.Equal(0.9, misconfig.SkipRate, 3);
        Assert.True(misconfig.SkipScore > 0.8);
        Assert.InRange(misconfig.HotspotScore, 0, 100);
    }

    [Fact]
    public async Task RepositoryFilter_ScopesResults()
    {
        var store = await SeededStoreAsync();
        var service = BuildService(store);

        var repoBHotspots = await service.GetHotspotsAsync(RepoB, Lookback);

        Assert.All(repoBHotspots, h => Assert.Equal(RepoB, h.Repository));
        Assert.Single(repoBHotspots);
        Assert.Equal("AGENTS.md", repoBHotspots[0].ContextFile);
    }

    [Fact]
    public async Task GetRepositories_ReturnsKnownReposAndExcludesUnknown()
    {
        var store = await SeededStoreAsync();
        var service = BuildService(store);

        var repos = await service.GetRepositoriesAsync(Lookback);

        Assert.Contains(RepoA, repos);
        Assert.Contains(RepoB, repos);
        Assert.DoesNotContain("unknown", repos);
    }

    [Fact]
    public async Task EmptyStore_ReturnsNoHotspots()
    {
        var store = new InMemoryContextInsightStore();
        var service = BuildService(store);

        var hotspots = await service.GetHotspotsAsync(null, Lookback);

        Assert.Empty(hotspots);
    }
}
