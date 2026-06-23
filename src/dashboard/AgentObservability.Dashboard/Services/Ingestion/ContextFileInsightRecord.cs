namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Lightweight read model for a single stored context-file insight row, projected from
/// <see cref="ContextFileInsightEntity"/> for hotspot analytics queries.
/// </summary>
public sealed record ContextFileInsightRecord
{
    // Provenance / identity.
    public required string OrgId { get; init; }
    public required string PseudonymousDeveloperId { get; init; }

    // Dimensions.
    public required DateTimeOffset BucketStart { get; init; }
    public int BucketDurationSeconds { get; init; }
    public required string Repository { get; init; }
    public required string ContextFile { get; init; }
    public required string Category { get; init; }

    // Measures.
    public int AppliedCount { get; init; }
    public int SkippedCount { get; init; }
    public int? SkipApplyToNoMatch { get; init; }
    public int? SkipOther { get; init; }
    public long EstTokensSum { get; init; }
    public long EstTokensMax { get; init; }
    public int SessionsWithErrorCount { get; init; }
    public int SessionsWithDeviationCount { get; init; }
    public int DistinctSessionCount { get; init; }
    public long? LastActivityAtMs { get; init; }

    public static ContextFileInsightRecord FromEntity(ContextFileInsightEntity entity)
    {
        ArgumentNullException.ThrowIfNull(entity);

        return new ContextFileInsightRecord
        {
            OrgId = entity.PartitionKey,
            PseudonymousDeveloperId = entity.DeveloperId,
            BucketStart = entity.BucketStart,
            BucketDurationSeconds = entity.BucketDurationSeconds,
            Repository = entity.Repository,
            ContextFile = entity.ContextFile,
            Category = entity.Category,
            AppliedCount = entity.AppliedCount,
            SkippedCount = entity.SkippedCount,
            SkipApplyToNoMatch = entity.SkipApplyToNoMatch,
            SkipOther = entity.SkipOther,
            EstTokensSum = entity.EstTokensSum,
            EstTokensMax = entity.EstTokensMax,
            SessionsWithErrorCount = entity.SessionsWithErrorCount,
            SessionsWithDeviationCount = entity.SessionsWithDeviationCount,
            DistinctSessionCount = entity.DistinctSessionCount,
            LastActivityAtMs = entity.LastActivityAtMs,
        };
    }
}
