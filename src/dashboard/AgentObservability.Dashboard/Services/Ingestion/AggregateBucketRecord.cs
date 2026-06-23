using System.Globalization;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Lightweight read model for a single stored aggregate bucket, projected from
/// <see cref="AggregateBucketEntity"/> for analytics queries. The latency histogram is parsed back
/// from the stored CSV string into an <see cref="int"/> array so callers can merge it element-wise.
/// </summary>
public sealed record AggregateBucketRecord
{
    // Provenance / identity.
    public required string OrgId { get; init; }
    public required string PseudonymousDeveloperId { get; init; }

    // Dimensions.
    public required DateTimeOffset BucketStart { get; init; }
    public int BucketDurationSeconds { get; init; }
    public required string Repository { get; init; }
    public string? RepositoryBranch { get; init; }
    public required string Model { get; init; }
    public required string AgentMode { get; init; }
    public required string Operation { get; init; }
    public string? ToolName { get; init; }

    // Measures.
    public int InteractionCount { get; init; }
    public int SuccessCount { get; init; }
    public int ErrorCount { get; init; }
    public long InputTokens { get; init; }
    public long OutputTokens { get; init; }
    public long CachedTokens { get; init; }
    public long? ReasoningTokens { get; init; }
    public double DurationMsSum { get; init; }
    public int DistinctSessionCount { get; init; }
    public long? LastActivityAtMs { get; init; }

    /// <summary>Parsed histogram counts (length 9: 8 bounds + the +Inf overflow bucket).</summary>
    public required IReadOnlyList<int> LatencyHistogramCounts { get; init; }

    public static AggregateBucketRecord FromEntity(AggregateBucketEntity entity)
    {
        ArgumentNullException.ThrowIfNull(entity);

        return new AggregateBucketRecord
        {
            OrgId = entity.PartitionKey,
            PseudonymousDeveloperId = entity.DeveloperId,
            BucketStart = entity.BucketStart,
            BucketDurationSeconds = entity.BucketDurationSeconds,
            Repository = entity.Repository,
            RepositoryBranch = entity.RepositoryBranch,
            Model = entity.Model,
            AgentMode = entity.AgentMode,
            Operation = entity.Operation,
            ToolName = entity.ToolName,
            InteractionCount = entity.InteractionCount,
            SuccessCount = entity.SuccessCount,
            ErrorCount = entity.ErrorCount,
            InputTokens = entity.InputTokens,
            OutputTokens = entity.OutputTokens,
            CachedTokens = entity.CachedTokens,
            ReasoningTokens = entity.ReasoningTokens,
            DurationMsSum = entity.DurationMsSum,
            DistinctSessionCount = entity.DistinctSessionCount,
            LastActivityAtMs = entity.LastActivityAtMs,
            LatencyHistogramCounts = ParseHistogram(entity.LatencyHistogramCounts),
        };
    }

    /// <summary>
    /// Parses the stored CSV histogram (e.g. "0,1,2,3,4,1,1,0,0") into an int array. Tolerates an
    /// empty/blank string (returns an empty array) and skips unparsable segments defensively.
    /// </summary>
    private static int[] ParseHistogram(string? csv)
    {
        if (string.IsNullOrWhiteSpace(csv))
        {
            return [];
        }

        var segments = csv.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        var counts = new int[segments.Length];

        for (var index = 0; index < segments.Length; index++)
        {
            counts[index] = int.TryParse(segments[index], NumberStyles.Integer, CultureInfo.InvariantCulture, out var value)
                ? value
                : 0;
        }

        return counts;
    }
}
