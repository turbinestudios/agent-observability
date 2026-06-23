using System.Text.Json.Serialization;

namespace AgentObservability.Dashboard.Models.Ingestion;

/// <summary>
/// Small status heartbeat POSTed by the extension to <c>/api/ingest/status</c> so the platform
/// can observe sync health per developer without any raw content. Carries only the pseudonymous
/// developer id (never an email), the tool version, and coarse counters/timestamps.
///
/// As with <see cref="AggregateBatch"/>, unknown JSON members are disallowed so no unexpected
/// (potentially sensitive) field can ride along.
/// </summary>
[JsonUnmappedMemberHandling(JsonUnmappedMemberHandling.Disallow)]
public sealed record SyncStatusReport
{
    [JsonPropertyName("schemaVersion")]
    public required string SchemaVersion { get; init; } // const "1.0"

    [JsonPropertyName("pseudonymousDeveloperId")]
    public required string PseudonymousDeveloperId { get; init; }

    [JsonPropertyName("toolVersion")]
    public required string ToolVersion { get; init; }

    [JsonPropertyName("lastSyncAt")]
    public required DateTimeOffset LastSyncAt { get; init; }

    [JsonPropertyName("lastBatchId")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LastBatchId { get; init; }

    [JsonPropertyName("pendingBatchCount")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? PendingBatchCount { get; init; }

    [JsonPropertyName("lastError")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? LastError { get; init; }
}
