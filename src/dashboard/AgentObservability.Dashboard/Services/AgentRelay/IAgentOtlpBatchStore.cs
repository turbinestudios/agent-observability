using AgentObservability.Dashboard.Models.AgentRelay;

namespace AgentObservability.Dashboard.Services.AgentRelay;

/// <summary>
/// Storage abstraction for the autonomous-agent OTLP relay. Batches are stored VERBATIM (the exact
/// bytes the producer pushed) and are org-scoped: every operation takes the authenticated
/// <paramref name="orgId"/> and a caller can only ever list/fetch its own org's batches.
/// </summary>
public interface IAgentOtlpBatchStore
{
    /// <summary>
    /// Persist one raw OTLP body and return its pointer. The id is server-minted and time-sortable;
    /// <paramref name="createdAtMs"/> is the server ingest clock (passed in so it is deterministic
    /// in tests).
    /// </summary>
    Task<AgentOtlpBatchRef> StoreAsync(
        string orgId,
        string service,
        string body,
        long createdAtMs,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// List the org's batches with <c>createdAtMs &gt;= sinceMs</c>, OLDEST-FIRST, capped to
    /// <paramref name="limit"/>. Oldest-first is required for correctness: the puller advances its
    /// watermark to the newest returned batch and dedupes by id, so returning the oldest un-acked
    /// window guarantees monotonic progress with no skipped batches under backlog.
    /// </summary>
    Task<IReadOnlyList<AgentOtlpBatchRef>> ListAsync(
        string orgId,
        long sinceMs,
        int limit,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Return the verbatim raw body for <paramref name="id"/> within <paramref name="orgId"/>, or
    /// <c>null</c> when it does not exist for that org (mapped to 404).
    /// </summary>
    Task<string?> DownloadAsync(
        string orgId,
        string id,
        CancellationToken cancellationToken = default);

    /// <summary>Create the backing container if it does not exist. Called once at startup.</summary>
    Task EnsureContainerExistsAsync(CancellationToken cancellationToken = default);
}
