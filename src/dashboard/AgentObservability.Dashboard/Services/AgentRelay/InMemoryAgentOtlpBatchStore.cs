using System.Collections.Concurrent;
using System.Text;
using AgentObservability.Dashboard.Models.AgentRelay;

namespace AgentObservability.Dashboard.Services.AgentRelay;

/// <summary>
/// In-memory <see cref="IAgentOtlpBatchStore"/> for tests (and a no-Azure fallback). Mirrors the
/// blob store's semantics: batches are keyed by (orgId, id), listing is org-scoped, filtered by
/// <c>createdAtMs &gt;= sinceMs</c>, returned OLDEST-FIRST and capped, and a download only resolves
/// within the same org.
/// </summary>
public sealed class InMemoryAgentOtlpBatchStore : IAgentOtlpBatchStore
{
    private sealed record Entry(AgentOtlpBatchRef Ref, string Body);

    private readonly ConcurrentDictionary<(string OrgId, string Id), Entry> _batches = new();

    /// <summary>All stored refs (test inspection).</summary>
    public IReadOnlyCollection<AgentOtlpBatchRef> Batches => _batches.Values.Select(e => e.Ref).ToList();

    public int Count => _batches.Count;

    public Task<AgentOtlpBatchRef> StoreAsync(
        string orgId,
        string service,
        string body,
        long createdAtMs,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);

        var id = AgentBatchId.Mint(createdAtMs);
        var reference = new AgentOtlpBatchRef
        {
            Id = id,
            Service = string.IsNullOrEmpty(service) ? "unknown" : service,
            CreatedAtMs = createdAtMs,
            SizeBytes = Encoding.UTF8.GetByteCount(body),
        };
        _batches[(orgId, id)] = new Entry(reference, body);
        return Task.FromResult(reference);
    }

    public Task<IReadOnlyList<AgentOtlpBatchRef>> ListAsync(
        string orgId,
        long sinceMs,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);

        var refs = _batches
            .Where(kvp => kvp.Key.OrgId == orgId && kvp.Value.Ref.CreatedAtMs >= sinceMs)
            .Select(kvp => kvp.Value.Ref)
            .OrderBy(r => r.CreatedAtMs)
            .ThenBy(r => r.Id, StringComparer.Ordinal)
            .Take(Math.Max(1, limit))
            .ToList();

        return Task.FromResult<IReadOnlyList<AgentOtlpBatchRef>>(refs);
    }

    public Task<string?> DownloadAsync(string orgId, string id, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);

        if (!AgentBatchId.IsValid(id))
        {
            return Task.FromResult<string?>(null);
        }

        return Task.FromResult(_batches.TryGetValue((orgId, id), out var entry) ? entry.Body : null);
    }

    public Task EnsureContainerExistsAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
}
