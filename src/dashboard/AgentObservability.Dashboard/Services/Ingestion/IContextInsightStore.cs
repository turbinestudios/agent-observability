using AgentObservability.Dashboard.Models.Ingestion;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Persists context-file insight rows, keyed by the validated org (from the key record, never the
/// payload). Implementations upsert by a deterministic row key so re-sent or overlapping batches
/// converge to a single row (latest-wins) instead of double-counting.
/// </summary>
public interface IContextInsightStore
{
    Task UpsertRowsAsync(string orgId, ContextInsightsBatch batch, CancellationToken cancellationToken = default);

    /// <summary>
    /// Reads stored rows whose <c>BucketStart</c> falls in the closed-open range
    /// <paramref name="sinceUtc"/> (inclusive) .. <paramref name="untilUtc"/> (exclusive).
    /// When <paramref name="orgId"/> is null or empty, queries ALL orgs (cross-partition).
    /// </summary>
    Task<IReadOnlyList<ContextFileInsightRecord>> QueryRowsAsync(
        string? orgId,
        DateTimeOffset sinceUtc,
        DateTimeOffset untilUtc,
        CancellationToken cancellationToken = default);
}
