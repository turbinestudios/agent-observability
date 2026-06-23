using AgentObservability.Dashboard.Models.Ingestion;
using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Azure Table Storage backed <see cref="IContextInsightStore"/>. Upserts each row in
/// <see cref="TableUpdateMode.Replace"/> mode so a re-sent batch replaces the prior row value
/// (latest-wins) rather than accumulating duplicates — the authoritative idempotency mechanism.
/// </summary>
public sealed class TableContextInsightStore : IContextInsightStore
{
    public const string TableName = "IngestionContextInsights";

    private readonly TableClient _table;
    private readonly ILogger<TableContextInsightStore> _logger;

    public TableContextInsightStore(TableServiceClient tableServiceClient, ILogger<TableContextInsightStore> logger)
    {
        _table = tableServiceClient.GetTableClient(TableName);
        _logger = logger;
    }

    public async Task EnsureTablesExistAsync()
    {
        await _table.CreateIfNotExistsAsync();
    }

    public async Task UpsertRowsAsync(string orgId, ContextInsightsBatch batch, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);
        ArgumentNullException.ThrowIfNull(batch);

        foreach (var row in batch.Rows)
        {
            var entity = ContextFileInsightEntity.FromRow(orgId, batch, row);
            await _table.UpsertEntityAsync(entity, TableUpdateMode.Replace, cancellationToken)
                .ConfigureAwait(false);
        }

        _logger.LogInformation(
            "Ingested {Count} context-insight row(s) for org {OrgId} (batch {BatchId}).",
            batch.Rows.Count, orgId, batch.BatchId);
    }

    public async Task<IReadOnlyList<ContextFileInsightRecord>> QueryRowsAsync(
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

        var records = new List<ContextFileInsightRecord>();

        await foreach (var entity in _table.QueryAsync<ContextFileInsightEntity>(filter, cancellationToken: cancellationToken)
            .ConfigureAwait(false))
        {
            records.Add(ContextFileInsightRecord.FromEntity(entity));
        }

        return records;
    }
}
