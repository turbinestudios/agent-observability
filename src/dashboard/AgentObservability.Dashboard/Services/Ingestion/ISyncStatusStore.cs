using AgentObservability.Dashboard.Models.Ingestion;
using Azure;
using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Stores the latest <see cref="SyncStatusReport"/> per (org, developer) so the platform can
/// observe sync health. Like the aggregate store, the org is key-derived.
/// </summary>
public interface ISyncStatusStore
{
    Task SaveAsync(string orgId, SyncStatusReport report, CancellationToken cancellationToken = default);
}

/// <summary>
/// Azure Table row for a developer's latest sync status. PartitionKey = orgId, RowKey = developerId.
/// </summary>
public sealed class SyncStatusEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }

    public string SchemaVersion { get; set; } = string.Empty;
    public string ToolVersion { get; set; } = string.Empty;
    public DateTimeOffset LastSyncAt { get; set; }
    public string? LastBatchId { get; set; }
    public int? PendingBatchCount { get; set; }
    public string? LastError { get; set; }
}

/// <summary>
/// Azure Table Storage backed <see cref="ISyncStatusStore"/> over table 'IngestionSyncStatus'.
/// Upserts (Replace) so each report overwrites the developer's prior status.
/// </summary>
public sealed class TableSyncStatusStore : ISyncStatusStore
{
    public const string TableName = "IngestionSyncStatus";

    private readonly TableClient _table;

    public TableSyncStatusStore(TableServiceClient tableServiceClient)
    {
        _table = tableServiceClient.GetTableClient(TableName);
    }

    public async Task EnsureTablesExistAsync()
    {
        await _table.CreateIfNotExistsAsync();
    }

    public async Task SaveAsync(string orgId, SyncStatusReport report, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);
        ArgumentNullException.ThrowIfNull(report);

        var entity = new SyncStatusEntity
        {
            PartitionKey = orgId,
            RowKey = report.PseudonymousDeveloperId,
            SchemaVersion = report.SchemaVersion,
            ToolVersion = report.ToolVersion,
            LastSyncAt = report.LastSyncAt,
            LastBatchId = report.LastBatchId,
            PendingBatchCount = report.PendingBatchCount,
            LastError = report.LastError,
        };

        await _table.UpsertEntityAsync(entity, TableUpdateMode.Replace, cancellationToken).ConfigureAwait(false);
    }
}

/// <summary>In-memory <see cref="ISyncStatusStore"/> for tests / no-Azure fallback.</summary>
public sealed class InMemorySyncStatusStore : ISyncStatusStore
{
    private readonly Dictionary<(string OrgId, string DeveloperId), SyncStatusReport> _reports = new();
    private readonly object _gate = new();

    public Task SaveAsync(string orgId, SyncStatusReport report, CancellationToken cancellationToken = default)
    {
        lock (_gate)
        {
            _reports[(orgId, report.PseudonymousDeveloperId)] = report;
        }

        return Task.CompletedTask;
    }

    public int Count
    {
        get { lock (_gate) { return _reports.Count; } }
    }
}
