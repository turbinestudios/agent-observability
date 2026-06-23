using System.Globalization;
using AgentObservability.Dashboard.Models.Ingestion;
using Azure;
using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Azure Table Storage row for a single context-file insight row.
/// <list type="bullet">
/// <item><description><c>PartitionKey</c> = orgId (key-derived; never from the payload).</description></item>
/// <item><description><c>RowKey</c> = <c>{bucketStartUtc:yyyyMMddHHmmss}-{rowKey}</c> — time-sortable
/// AND idempotent: the producer <c>rowKey</c> already hashes the full grain
/// (bucketStart, repository, contextFile, category) + developer id, so the same wall-clock bucket +
/// grain always collides and an upsert in Replace mode makes re-sends latest-wins.</description></item>
/// </list>
/// The closed-set skip reasons are flattened into two nullable columns; file CONTENTS are never
/// stored (only the allowlisted repo-relative path plus aggregate counts).
/// </summary>
public sealed class ContextFileInsightEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }

    // Idempotency / provenance.
    public string RowKeyHash { get; set; } = string.Empty;
    public string DeveloperId { get; set; } = string.Empty;
    public string BatchId { get; set; } = string.Empty;
    public string ToolVersion { get; set; } = string.Empty;

    // Dimensions.
    public DateTimeOffset BucketStart { get; set; }
    public int BucketDurationSeconds { get; set; }
    public string Repository { get; set; } = string.Empty;
    public string ContextFile { get; set; } = string.Empty;
    public string Category { get; set; } = string.Empty;

    // Measures.
    public int AppliedCount { get; set; }
    public int SkippedCount { get; set; }
    public int? SkipApplyToNoMatch { get; set; }
    public int? SkipOther { get; set; }
    public long EstTokensSum { get; set; }
    public long EstTokensMax { get; set; }
    public int SessionsWithErrorCount { get; set; }
    public int SessionsWithDeviationCount { get; set; }
    public int DistinctSessionCount { get; set; }
    public long? LastActivityAtMs { get; set; }

    /// <summary>
    /// Builds the time-sortable, idempotent RowKey: the UTC bucket start (yyyyMMddHHmmss) followed
    /// by the producer-supplied per-row idempotency key (which encodes the full grain).
    /// </summary>
    public static string BuildRowKey(DateTimeOffset bucketStart, string rowKeyHash)
    {
        var stamp = bucketStart.UtcDateTime.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
        return $"{stamp}-{rowKeyHash}";
    }

    public static ContextFileInsightEntity FromRow(string orgId, ContextInsightsBatch batch, ContextFileRow row)
    {
        return new ContextFileInsightEntity
        {
            PartitionKey = orgId,
            RowKey = BuildRowKey(row.BucketStart, row.RowKey),
            RowKeyHash = row.RowKey,
            DeveloperId = batch.PseudonymousDeveloperId,
            BatchId = batch.BatchId,
            ToolVersion = batch.ToolVersion,
            BucketStart = row.BucketStart,
            BucketDurationSeconds = row.BucketDurationSeconds,
            Repository = row.Repository,
            ContextFile = row.ContextFile,
            Category = row.Category,
            AppliedCount = row.AppliedCount,
            SkippedCount = row.SkippedCount,
            SkipApplyToNoMatch = row.SkipReasonCounts?.ApplyToNoMatch,
            SkipOther = row.SkipReasonCounts?.Other,
            EstTokensSum = row.EstTokensSum,
            EstTokensMax = row.EstTokensMax,
            SessionsWithErrorCount = row.SessionsWithErrorCount,
            SessionsWithDeviationCount = row.SessionsWithDeviationCount,
            DistinctSessionCount = row.DistinctSessionCount,
            LastActivityAtMs = row.LastActivityAtMs,
        };
    }
}
