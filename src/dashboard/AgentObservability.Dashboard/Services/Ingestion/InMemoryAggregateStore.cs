using System.Collections.Concurrent;
using AgentObservability.Dashboard.Models.Ingestion;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// In-memory <see cref="IAggregateStore"/> for tests (and as a no-Azure fallback). Keys rows the
/// same way as <see cref="TableAggregateStore"/> ((PartitionKey, RowKey) = (orgId, time-sortable
/// idempotent key)) so re-sending an identical batch replaces rows instead of adding them — making
/// idempotency observable without live Azure.
/// </summary>
public sealed class InMemoryAggregateStore : IAggregateStore
{
    private readonly ConcurrentDictionary<(string OrgId, string RowKey), AggregateBucketEntity> _rows = new();

    public IReadOnlyCollection<AggregateBucketEntity> Buckets => _rows.Values.ToList();

    public int Count => _rows.Count;

    public Task UpsertBucketsAsync(string orgId, AggregateBatch batch, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);
        ArgumentNullException.ThrowIfNull(batch);

        foreach (var bucket in batch.Buckets)
        {
            var entity = AggregateBucketEntity.FromBucket(orgId, batch, bucket);
            _rows[(orgId, entity.RowKey)] = entity; // Replace => latest-wins, idempotent.
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<AggregateBucketRecord>> QueryBucketsAsync(
        string? orgId,
        DateTimeOffset sinceUtc,
        DateTimeOffset untilUtc,
        CancellationToken cancellationToken = default)
    {
        var matchAllOrgs = string.IsNullOrEmpty(orgId);

        var records = _rows.Values
            .Where(entity =>
                (matchAllOrgs || entity.PartitionKey == orgId) &&
                entity.BucketStart >= sinceUtc &&
                entity.BucketStart < untilUtc)
            .Select(AggregateBucketRecord.FromEntity)
            .ToList();

        return Task.FromResult<IReadOnlyList<AggregateBucketRecord>>(records);
    }
}
