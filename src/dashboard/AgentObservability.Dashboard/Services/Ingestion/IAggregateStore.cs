using AgentObservability.Dashboard.Models.Ingestion;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Persists aggregate buckets, keyed by the validated org (from the key record, never the payload).
/// Implementations upsert by a deterministic row key so re-sent or overlapping batches converge to
/// a single row (latest-wins) instead of double-counting.
/// </summary>
public interface IAggregateStore
{
    Task UpsertBucketsAsync(string orgId, AggregateBatch batch, CancellationToken cancellationToken = default);

    /// <summary>
    /// Reads stored buckets whose <c>BucketStart</c> falls in the closed-open range
    /// <paramref name="sinceUtc"/> (inclusive) .. <paramref name="untilUtc"/> (exclusive).
    /// When <paramref name="orgId"/> is null or empty, queries ALL orgs (cross-partition).
    /// </summary>
    Task<IReadOnlyList<AggregateBucketRecord>> QueryBucketsAsync(
        string? orgId,
        DateTimeOffset sinceUtc,
        DateTimeOffset untilUtc,
        CancellationToken cancellationToken = default);
}
