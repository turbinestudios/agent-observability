using System.Globalization;
using AgentObservability.Dashboard.Models.Ingestion;
using Azure;
using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Azure Table Storage row for a single aggregate bucket.
/// <list type="bullet">
/// <item><description><c>PartitionKey</c> = orgId (key-derived; never from the payload).</description></item>
/// <item><description><c>RowKey</c> = <c>{bucketStartUtc:yyyyMMddHHmmss}-{rowKey}</c> — time-sortable
/// AND idempotent: the same wall-clock bucket + grain always collides, so an upsert in Replace mode
/// makes re-sends latest-wins.</description></item>
/// </list>
/// The latency histogram counts are stored as a CSV string (<c>LatencyHistogramCounts</c>); the
/// fixed bounds are not stored (they are a global constant).
/// </summary>
public sealed class AggregateBucketEntity : ITableEntity
{
    public string PartitionKey { get; set; } = string.Empty;
    public string RowKey { get; set; } = string.Empty;
    public DateTimeOffset? Timestamp { get; set; }
    public ETag ETag { get; set; }

    // Idempotency / provenance.
    public string BucketRowKey { get; set; } = string.Empty;
    public string DeveloperId { get; set; } = string.Empty;
    public string BatchId { get; set; } = string.Empty;
    public string ToolVersion { get; set; } = string.Empty;

    // Dimensions.
    public DateTimeOffset BucketStart { get; set; }
    public int BucketDurationSeconds { get; set; }
    public string Repository { get; set; } = string.Empty;
    public string? RepositoryBranch { get; set; }
    public string Model { get; set; } = string.Empty;
    public string AgentMode { get; set; } = string.Empty;
    public string Operation { get; set; } = string.Empty;
    public string? ToolName { get; set; }

    // Measures.
    public int InteractionCount { get; set; }
    public int SuccessCount { get; set; }
    public int ErrorCount { get; set; }
    public long InputTokens { get; set; }
    public long OutputTokens { get; set; }
    public long CachedTokens { get; set; }
    public long? ReasoningTokens { get; set; }
    public double DurationMsSum { get; set; }
    public int DistinctSessionCount { get; set; }
    public long? LastActivityAtMs { get; set; }

    /// <summary>CSV of the 9 histogram counts (e.g. "0,1,2,3,4,1,1,0,0").</summary>
    public string LatencyHistogramCounts { get; set; } = string.Empty;

    /// <summary>
    /// Builds the time-sortable, idempotent RowKey for a bucket: the UTC bucket start (yyyyMMddHHmmss)
    /// followed by the producer-supplied per-row idempotency key.
    /// </summary>
    public static string BuildRowKey(DateTimeOffset bucketStart, string bucketRowKey)
    {
        var stamp = bucketStart.UtcDateTime.ToString("yyyyMMddHHmmss", CultureInfo.InvariantCulture);
        return $"{stamp}-{bucketRowKey}";
    }

    public static AggregateBucketEntity FromBucket(string orgId, AggregateBatch batch, AggregateBucket bucket)
    {
        return new AggregateBucketEntity
        {
            PartitionKey = orgId,
            RowKey = BuildRowKey(bucket.BucketStart, bucket.RowKey),
            BucketRowKey = bucket.RowKey,
            DeveloperId = batch.PseudonymousDeveloperId,
            BatchId = batch.BatchId,
            ToolVersion = batch.ToolVersion,
            BucketStart = bucket.BucketStart,
            BucketDurationSeconds = bucket.BucketDurationSeconds,
            Repository = bucket.Repository,
            RepositoryBranch = bucket.RepositoryBranch,
            Model = bucket.Model,
            AgentMode = bucket.AgentMode,
            Operation = bucket.Operation,
            ToolName = bucket.ToolName,
            InteractionCount = bucket.InteractionCount,
            SuccessCount = bucket.SuccessCount,
            ErrorCount = bucket.ErrorCount,
            InputTokens = bucket.InputTokens,
            OutputTokens = bucket.OutputTokens,
            CachedTokens = bucket.CachedTokens,
            ReasoningTokens = bucket.ReasoningTokens,
            DurationMsSum = bucket.DurationMsSum,
            DistinctSessionCount = bucket.DistinctSessionCount,
            LastActivityAtMs = bucket.LastActivityAtMs,
            LatencyHistogramCounts = string.Join(',', bucket.LatencyHistogram.Counts),
        };
    }
}
