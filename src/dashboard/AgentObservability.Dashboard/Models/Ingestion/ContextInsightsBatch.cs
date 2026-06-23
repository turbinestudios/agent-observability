using System.Text.Json.Serialization;

namespace AgentObservability.Dashboard.Models.Ingestion;

/// <summary>
/// Privacy-scoped context-insights batch POSTed by the VS Code extension to
/// <c>POST /api/ingest/context-insights</c>. Mirrors
/// <c>schemas/context-insights-batch.schema.json</c> exactly.
///
/// This is a SEPARATE, additive contract from <see cref="AggregateBatch"/>: it is the first
/// batch to convey repo-relative customization-file PATHS to the cloud (instructions/skills/
/// prompts/agents/hooks only), so a team can review per-repository, per-sprint hotspots in their
/// context engineering. It NEVER carries file contents, raw skip-reason text, branches, or
/// identities.
///
/// Each DTO is annotated with <see cref="JsonUnmappedMemberHandlingAttribute"/> set to
/// <see cref="JsonUnmappedMemberHandling.Disallow"/> — the structural raw-field rejection
/// mechanism mirroring <c>additionalProperties: false</c> in the schema: any unexpected JSON
/// property makes deserialization throw rather than being silently ignored.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ContextInsightsBatch
{
    [JsonPropertyName("schemaVersion")]
    public required string SchemaVersion { get; init; } // const "1.0"

    [JsonPropertyName("batchId")]
    public required string BatchId { get; init; }

    [JsonPropertyName("generatedAt")]
    public required DateTimeOffset GeneratedAt { get; init; }

    [JsonPropertyName("toolVersion")]
    public required string ToolVersion { get; init; }

    [JsonPropertyName("pseudonymousDeveloperId")]
    public required string PseudonymousDeveloperId { get; init; }

    [JsonPropertyName("window")]
    public required ContextInsightsWindow Window { get; init; }

    [JsonPropertyName("rows")]
    public required IReadOnlyList<ContextFileRow> Rows { get; init; } = [];
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ContextInsightsWindow
{
    [JsonPropertyName("start")]
    public required DateTimeOffset Start { get; init; }

    [JsonPropertyName("end")]
    public required DateTimeOffset End { get; init; }
}

/// <summary>
/// One aggregate row at the grain
/// <c>(bucketStart, bucketDurationSeconds, repository, contextFile, category)</c> for a single
/// <see cref="ContextInsightsBatch.PseudonymousDeveloperId"/>. All measures are additive across
/// rows EXCEPT <see cref="DistinctSessionCount"/> and <see cref="EstTokensMax"/> (a max).
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record ContextFileRow
{
    [JsonPropertyName("rowKey")]
    public required string RowKey { get; init; }

    [JsonPropertyName("bucketStart")]
    public required DateTimeOffset BucketStart { get; init; }

    [JsonPropertyName("bucketDurationSeconds")]
    public required int BucketDurationSeconds { get; init; } // const 1800 (30 min) in v1

    [JsonPropertyName("repository")]
    public required string Repository { get; init; } // SANITIZED https://{host}/{owner}/{repo} or "unknown"

    [JsonPropertyName("contextFile")]
    public required string ContextFile { get; init; } // allowlisted repo-relative POSIX path

    [JsonPropertyName("category")]
    public required string Category { get; init; } // instruction | skill | agent | hook | prompt

    [JsonPropertyName("appliedCount")]
    public required int AppliedCount { get; init; }

    [JsonPropertyName("skippedCount")]
    public required int SkippedCount { get; init; }

    [JsonPropertyName("skipReasonCounts")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public SkipReasonCounts? SkipReasonCounts { get; init; }

    [JsonPropertyName("estTokensSum")]
    public required long EstTokensSum { get; init; }

    [JsonPropertyName("estTokensMax")]
    public required long EstTokensMax { get; init; }

    [JsonPropertyName("sessionsWithErrorCount")]
    public required int SessionsWithErrorCount { get; init; }

    [JsonPropertyName("sessionsWithDeviationCount")]
    public required int SessionsWithDeviationCount { get; init; }

    [JsonPropertyName("distinctSessionCount")]
    public required int DistinctSessionCount { get; init; } // per-row context only; NOT additive

    [JsonPropertyName("lastActivityAtMs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? LastActivityAtMs { get; init; }
}

/// <summary>
/// Closed-set taxonomy of skip reasons. Property names are a fixed vocabulary; raw reason
/// strings are mapped into these buckets locally and never transmitted.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record SkipReasonCounts
{
    [JsonPropertyName("applyToNoMatch")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? ApplyToNoMatch { get; init; }

    [JsonPropertyName("other")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Other { get; init; }
}
