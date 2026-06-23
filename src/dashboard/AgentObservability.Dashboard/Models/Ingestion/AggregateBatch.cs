using System.Text.Json.Serialization;

namespace AgentObservability.Dashboard.Models.Ingestion;

/// <summary>
/// Privacy-first aggregate telemetry batch POSTed by the VS Code extension to the
/// dashboard ingestion API. Mirrors <c>schemas/aggregate-batch.schema.json</c> exactly.
///
/// Each DTO is annotated with <see cref="JsonUnmappedMemberHandlingAttribute"/> set to
/// <see cref="JsonUnmappedMemberHandling.Disallow"/>. This is the structural raw-field
/// rejection mechanism: the schema sets <c>additionalProperties: false</c> at every object
/// level, so any unexpected JSON property (potentially a raw/sensitive column) makes
/// deserialization throw a <see cref="System.Text.Json.JsonException"/> rather than being
/// silently ignored.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AggregateBatch
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
    public required AggregateWindow Window { get; init; }

    [JsonPropertyName("buckets")]
    public required IReadOnlyList<AggregateBucket> Buckets { get; init; } = [];
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AggregateWindow
{
    [JsonPropertyName("start")]
    public required DateTimeOffset Start { get; init; }

    [JsonPropertyName("end")]
    public required DateTimeOffset End { get; init; }
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record AggregateBucket
{
    [JsonPropertyName("rowKey")]
    public required string RowKey { get; init; }

    [JsonPropertyName("bucketStart")]
    public required DateTimeOffset BucketStart { get; init; }

    [JsonPropertyName("bucketDurationSeconds")]
    public required int BucketDurationSeconds { get; init; } // const 1800 (30 min) in v1

    [JsonPropertyName("repository")]
    public required string Repository { get; init; } // SANITIZED https://{host}/{owner}/{repo} or "unknown"

    [JsonPropertyName("repositoryBranch")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? RepositoryBranch { get; init; }

    [JsonPropertyName("model")]
    public required string Model { get; init; }

    [JsonPropertyName("agentMode")]
    public required string AgentMode { get; init; }

    [JsonPropertyName("operation")]
    public required string Operation { get; init; } // chat | execute_tool | execute_hook | invoke_agent

    [JsonPropertyName("toolName")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? ToolName { get; init; }

    [JsonPropertyName("interactionCount")]
    public required int InteractionCount { get; init; }

    [JsonPropertyName("successCount")]
    public required int SuccessCount { get; init; }

    [JsonPropertyName("errorCount")]
    public required int ErrorCount { get; init; }

    [JsonPropertyName("inputTokens")]
    public required long InputTokens { get; init; }

    [JsonPropertyName("outputTokens")]
    public required long OutputTokens { get; init; }

    [JsonPropertyName("cachedTokens")]
    public required long CachedTokens { get; init; }

    [JsonPropertyName("reasoningTokens")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? ReasoningTokens { get; init; }

    [JsonPropertyName("durationMsSum")]
    public required double DurationMsSum { get; init; }

    [JsonPropertyName("latencyHistogram")]
    public required LatencyHistogram LatencyHistogram { get; init; }

    [JsonPropertyName("distinctSessionCount")]
    public required int DistinctSessionCount { get; init; } // per-row context only; NOT additive

    [JsonPropertyName("lastActivityAtMs")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public long? LastActivityAtMs { get; init; } // optional; Unix epoch ms of latest span start (max over row)
}

[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record LatencyHistogram
{
    /// <summary>Must equal [100,250,500,1000,2000,5000,10000,30000].</summary>
    [JsonPropertyName("boundsMs")]
    public required IReadOnlyList<double> BoundsMs { get; init; }

    /// <summary>Length = BoundsMs.Count + 1 (= 9); last element is the +Inf overflow bucket.</summary>
    [JsonPropertyName("counts")]
    public required IReadOnlyList<long> Counts { get; init; }
}
