using AgentObservability.Dashboard.Models.Ingestion;
using AgentObservability.Dashboard.Services.Ingestion;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>Verifies <see cref="InMemoryAggregateStore.QueryBucketsAsync"/> time-range and org filtering.</summary>
public sealed class InMemoryAggregateStoreQueryTests
{
    private const string OrgId = "org-q";
    private const string DevId = "dev_00000000000000000000000000000a01";

    private static readonly double[] Bounds = [100, 250, 500, 1000, 2000, 5000, 10000, 30000];

    private static AggregateBucket Bucket(string rowKey, DateTimeOffset bucketStart) => new()
    {
        RowKey = rowKey,
        BucketStart = bucketStart,
        BucketDurationSeconds = 1800,
        Repository = "https://github.com/turbinestudios/alpha",
        Model = "gpt-4.1",
        AgentMode = "agent",
        Operation = "chat",
        InteractionCount = 1,
        SuccessCount = 1,
        ErrorCount = 0,
        InputTokens = 0,
        OutputTokens = 0,
        CachedTokens = 0,
        DurationMsSum = 1,
        LatencyHistogram = new LatencyHistogram { BoundsMs = Bounds, Counts = [0, 0, 1, 0, 0, 0, 0, 0, 0] },
        DistinctSessionCount = 1,
    };

    private static AggregateBatch Batch(string developerId, params AggregateBucket[] buckets) => new()
    {
        SchemaVersion = "1.0",
        BatchId = $"batch-{Guid.NewGuid():N}",
        GeneratedAt = new DateTimeOffset(2026, 6, 2, 12, 0, 0, TimeSpan.Zero),
        ToolVersion = "1.4.2",
        PseudonymousDeveloperId = developerId,
        Window = new AggregateWindow
        {
            Start = new DateTimeOffset(2026, 6, 1, 0, 0, 0, TimeSpan.Zero),
            End = new DateTimeOffset(2026, 6, 3, 0, 0, 0, TimeSpan.Zero),
        },
        Buckets = buckets,
    };

    [Fact]
    public async Task QueryBuckets_FiltersByBucketStartHalfOpenRange()
    {
        var store = new InMemoryAggregateStore();
        var t0 = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero);
        var t1 = new DateTimeOffset(2026, 6, 2, 8, 30, 0, TimeSpan.Zero);
        var t2 = new DateTimeOffset(2026, 6, 2, 9, 0, 0, TimeSpan.Zero);

        await store.UpsertBucketsAsync(OrgId, Batch(DevId,
            Bucket("before", t0.AddMinutes(-30)),
            Bucket("at-since", t0),
            Bucket("middle", t1),
            Bucket("at-until", t2),       // exclusive upper bound => excluded
            Bucket("after", t2.AddMinutes(30))));

        var records = await store.QueryBucketsAsync(OrgId, t0, t2, CancellationToken.None);

        // [t0, t2) => at-since (t0) and middle (t1) only.
        Assert.Equal(2, records.Count);
        Assert.Contains(records, r => r.BucketStart == t0);
        Assert.Contains(records, r => r.BucketStart == t1);
        Assert.DoesNotContain(records, r => r.BucketStart == t2);
        Assert.DoesNotContain(records, r => r.BucketStart < t0);
    }

    [Fact]
    public async Task QueryBuckets_NullOrgId_QueriesAllOrgs()
    {
        var store = new InMemoryAggregateStore();
        var t = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero);

        await store.UpsertBucketsAsync("org-1", Batch(DevId, Bucket("r1", t)));
        await store.UpsertBucketsAsync("org-2", Batch(DevId, Bucket("r2", t)));

        var all = await store.QueryBucketsAsync(null, t.AddHours(-1), t.AddHours(1), CancellationToken.None);
        Assert.Equal(2, all.Count);

        var scoped = await store.QueryBucketsAsync("org-1", t.AddHours(-1), t.AddHours(1), CancellationToken.None);
        Assert.Single(scoped);
        Assert.All(scoped, r => Assert.Equal("org-1", r.OrgId));
    }

    [Fact]
    public async Task QueryBuckets_ParsesHistogramCsvBackToCounts()
    {
        var store = new InMemoryAggregateStore();
        var t = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero);

        await store.UpsertBucketsAsync(OrgId, Batch(DevId, Bucket("r1", t)));

        var record = Assert.Single(await store.QueryBucketsAsync(OrgId, t, t.AddHours(1), CancellationToken.None));
        Assert.Equal([0, 0, 1, 0, 0, 0, 0, 0, 0], record.LatencyHistogramCounts);
    }
}
