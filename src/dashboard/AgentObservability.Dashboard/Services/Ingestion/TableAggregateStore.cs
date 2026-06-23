using AgentObservability.Dashboard.Models.Ingestion;
using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Azure Table Storage backed <see cref="IAggregateStore"/>. Upserts each bucket in
/// <see cref="TableUpdateMode.Replace"/> mode so a re-sent batch replaces the prior row value
/// (latest-wins) rather than accumulating duplicates — the authoritative idempotency mechanism.
/// </summary>
public sealed class TableAggregateStore : IAggregateStore
{
    public const string TableName = "IngestionAggregates";

    private readonly TableClient _table;
    private readonly ILogger<TableAggregateStore> _logger;

    public TableAggregateStore(TableServiceClient tableServiceClient, ILogger<TableAggregateStore> logger)
    {
        _table = tableServiceClient.GetTableClient(TableName);
        _logger = logger;
    }

    public async Task EnsureTablesExistAsync()
    {
        await _table.CreateIfNotExistsAsync();
    }

    public async Task UpsertBucketsAsync(string orgId, AggregateBatch batch, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);
        ArgumentNullException.ThrowIfNull(batch);

        foreach (var bucket in batch.Buckets)
        {
            var entity = AggregateBucketEntity.FromBucket(orgId, batch, bucket);
            await _table.UpsertEntityAsync(entity, TableUpdateMode.Replace, cancellationToken)
                .ConfigureAwait(false);
        }

        _logger.LogInformation(
            "Ingested {Count} aggregate bucket(s) for org {OrgId} (batch {BatchId}).",
            batch.Buckets.Count, orgId, batch.BatchId);
    }

    public async Task<IReadOnlyList<AggregateBucketRecord>> QueryBucketsAsync(
        string? orgId,
        DateTimeOffset sinceUtc,
        DateTimeOffset untilUtc,
        CancellationToken cancellationToken = default)
    {
        // Filter on the stored BucketStart range [sinceUtc, untilUtc). Scope to a single partition
        // (orgId) when provided; otherwise query across all partitions (orgs).
        var filter = string.IsNullOrEmpty(orgId)
            ? TableClient.CreateQueryFilter($"BucketStart ge {sinceUtc} and BucketStart lt {untilUtc}")
            : TableClient.CreateQueryFilter($"PartitionKey eq {orgId} and BucketStart ge {sinceUtc} and BucketStart lt {untilUtc}");

        var records = new List<AggregateBucketRecord>();

        await foreach (var entity in _table.QueryAsync<AggregateBucketEntity>(filter, cancellationToken: cancellationToken)
            .ConfigureAwait(false))
        {
            records.Add(AggregateBucketRecord.FromEntity(entity));
        }

        return records;
    }
}
