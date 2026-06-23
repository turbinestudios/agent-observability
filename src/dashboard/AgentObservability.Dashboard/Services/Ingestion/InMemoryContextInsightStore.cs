using System.Collections.Concurrent;
using AgentObservability.Dashboard.Models.Ingestion;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// In-memory <see cref="IContextInsightStore"/> for tests (and as a no-Azure fallback). Keys rows
/// the same way as <see cref="TableContextInsightStore"/> ((PartitionKey, RowKey) = (orgId,
/// time-sortable idempotent key)) so re-sending an identical batch replaces rows instead of adding
/// them — making idempotency observable without live Azure.
/// </summary>
public sealed class InMemoryContextInsightStore : IContextInsightStore
{
    private readonly ConcurrentDictionary<(string OrgId, string RowKey), ContextFileInsightEntity> _rows = new();

    public IReadOnlyCollection<ContextFileInsightEntity> Rows => _rows.Values.ToList();

    public int Count => _rows.Count;

    public Task UpsertRowsAsync(string orgId, ContextInsightsBatch batch, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);
        ArgumentNullException.ThrowIfNull(batch);

        foreach (var row in batch.Rows)
        {
            var entity = ContextFileInsightEntity.FromRow(orgId, batch, row);
            _rows[(orgId, entity.RowKey)] = entity; // Replace => latest-wins, idempotent.
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<ContextFileInsightRecord>> QueryRowsAsync(
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
            .Select(ContextFileInsightRecord.FromEntity)
            .ToList();

        return Task.FromResult<IReadOnlyList<ContextFileInsightRecord>>(records);
    }
}
