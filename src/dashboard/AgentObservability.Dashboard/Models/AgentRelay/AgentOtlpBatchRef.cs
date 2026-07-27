namespace AgentObservability.Dashboard.Models.AgentRelay;

/// <summary>
/// A pointer to one stored raw-OTLP batch in the autonomous-agent relay. Serialized to the shape
/// the extension's <c>AgentBlobClient.parseBatchRefs</c> expects: <c>{ id, service, createdAtMs,
/// sizeBytes }</c> (camelCase). It carries NO telemetry content — only the metadata needed to list
/// and fetch a batch. The org that owns the batch is implied by the caller's authenticated key and
/// is never part of this DTO.
/// </summary>
public sealed record AgentOtlpBatchRef
{
    /// <summary>Server-minted, opaque, URL-safe batch id (also the download handle).</summary>
    public required string Id { get; init; }

    /// <summary><c>service.name</c> from the batch's OTLP resource attributes, or <c>unknown</c>.</summary>
    public required string Service { get; init; }

    /// <summary>Server ingest time in Unix epoch milliseconds; the puller's watermark cursor.</summary>
    public required long CreatedAtMs { get; init; }

    /// <summary>Size of the stored raw body in bytes.</summary>
    public required long SizeBytes { get; init; }
}

/// <summary>
/// Envelope for <c>GET /agent-otlp/batches</c>. The extension accepts either a bare array or this
/// <c>{ batches: [...] }</c> form; we return the envelope.
/// </summary>
public sealed record AgentOtlpBatchListResponse
{
    public required IReadOnlyList<AgentOtlpBatchRef> Batches { get; init; }
}
