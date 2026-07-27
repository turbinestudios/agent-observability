using System.Globalization;
using System.Text;
using AgentObservability.Dashboard.Models.AgentRelay;
using Azure;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services.AgentRelay;

/// <summary>
/// Azure Blob Storage backed <see cref="IAgentOtlpBatchStore"/>. Each pushed OTLP batch is stored
/// VERBATIM as one blob named <c>{orgId}/{id}.json</c>, so listing/fetching are naturally org-scoped
/// by prefix and a caller can never reach another org's blobs (the id is constrained to a path-safe
/// alphabet by <see cref="AgentBatchId"/>). <c>service.name</c> and the ingest timestamp are kept in
/// blob metadata so listing builds refs without downloading bodies.
/// </summary>
public sealed class BlobAgentOtlpBatchStore : IAgentOtlpBatchStore
{
    private const string ServiceMetadataKey = "service";
    private const string CreatedAtMsMetadataKey = "createdatms";
    private const string BlobSuffix = ".json";

    private readonly BlobContainerClient _container;
    private readonly ILogger<BlobAgentOtlpBatchStore> _logger;

    public BlobAgentOtlpBatchStore(
        BlobServiceClient blobServiceClient,
        IOptions<AgentRelayOptions> options,
        ILogger<BlobAgentOtlpBatchStore> logger)
    {
        _container = blobServiceClient.GetBlobContainerClient(options.Value.ContainerName);
        _logger = logger;
    }

    public async Task EnsureContainerExistsAsync(CancellationToken cancellationToken = default)
    {
        await _container.CreateIfNotExistsAsync(PublicAccessType.None, cancellationToken: cancellationToken)
            .ConfigureAwait(false);
    }

    public async Task<AgentOtlpBatchRef> StoreAsync(
        string orgId,
        string service,
        string body,
        long createdAtMs,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);

        var resolvedService = string.IsNullOrEmpty(service) ? "unknown" : service;
        var id = AgentBatchId.Mint(createdAtMs);
        var bytes = Encoding.UTF8.GetBytes(body);
        var blob = _container.GetBlobClient(BlobName(orgId, id));

        var metadata = new Dictionary<string, string>
        {
            // Escaped so a non-ASCII service name is always a valid (header-safe) metadata value.
            [ServiceMetadataKey] = Uri.EscapeDataString(resolvedService),
            [CreatedAtMsMetadataKey] = createdAtMs.ToString(CultureInfo.InvariantCulture),
        };

        using var stream = new MemoryStream(bytes, writable: false);
        await blob.UploadAsync(
            stream,
            new BlobUploadOptions
            {
                HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" },
                Metadata = metadata,
            },
            cancellationToken).ConfigureAwait(false);

        _logger.LogInformation(
            "Stored agent OTLP batch {BatchId} ({SizeBytes} bytes, service {Service}) for org {OrgId}.",
            id, bytes.LongLength, resolvedService, orgId);

        return new AgentOtlpBatchRef
        {
            Id = id,
            Service = resolvedService,
            CreatedAtMs = createdAtMs,
            SizeBytes = bytes.LongLength,
        };
    }

    public async Task<IReadOnlyList<AgentOtlpBatchRef>> ListAsync(
        string orgId,
        long sinceMs,
        int limit,
        CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);

        var prefix = $"{orgId}/";
        var refs = new List<AgentOtlpBatchRef>();

        await foreach (var item in _container
            .GetBlobsAsync(traits: BlobTraits.Metadata, states: BlobStates.None, prefix: prefix, cancellationToken: cancellationToken)
            .ConfigureAwait(false))
        {
            var id = IdFromBlobName(item.Name, prefix);
            if (id is null)
            {
                continue;
            }

            var createdAtMs = ReadCreatedAtMs(item.Metadata, id);
            if (createdAtMs < sinceMs)
            {
                continue;
            }

            refs.Add(new AgentOtlpBatchRef
            {
                Id = id,
                Service = ReadService(item.Metadata),
                CreatedAtMs = createdAtMs,
                SizeBytes = item.Properties.ContentLength ?? 0,
            });
        }

        // Oldest-first + cap: guarantees the puller's watermark advances without skipping batches.
        return refs
            .OrderBy(r => r.CreatedAtMs)
            .ThenBy(r => r.Id, StringComparer.Ordinal)
            .Take(Math.Max(1, limit))
            .ToList();
    }

    public async Task<string?> DownloadAsync(string orgId, string id, CancellationToken cancellationToken = default)
    {
        ArgumentException.ThrowIfNullOrEmpty(orgId);

        // Reject anything that is not a path-safe minted id BEFORE composing a blob path.
        if (!AgentBatchId.IsValid(id))
        {
            return null;
        }

        var blob = _container.GetBlobClient(BlobName(orgId, id));
        try
        {
            var response = await blob.DownloadContentAsync(cancellationToken).ConfigureAwait(false);
            return response.Value.Content.ToString();
        }
        catch (RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }

    private static string BlobName(string orgId, string id) => $"{orgId}/{id}{BlobSuffix}";

    private static string? IdFromBlobName(string name, string prefix)
    {
        if (!name.StartsWith(prefix, StringComparison.Ordinal) || !name.EndsWith(BlobSuffix, StringComparison.Ordinal))
        {
            return null;
        }

        var id = name[prefix.Length..^BlobSuffix.Length];
        return AgentBatchId.IsValid(id) ? id : null;
    }

    private static long ReadCreatedAtMs(IDictionary<string, string>? metadata, string id)
    {
        if (metadata is not null
            && metadata.TryGetValue(CreatedAtMsMetadataKey, out var raw)
            && long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out var ms))
        {
            return ms;
        }

        // Fallback: the timestamp embedded in the id prefix ({createdAtMs:D13}-...).
        var dash = id.IndexOf('-', StringComparison.Ordinal);
        if (dash > 0 && long.TryParse(id[..dash], NumberStyles.Integer, CultureInfo.InvariantCulture, out var fromId))
        {
            return fromId;
        }

        return 0;
    }

    private static string ReadService(IDictionary<string, string>? metadata)
    {
        if (metadata is null || !metadata.TryGetValue(ServiceMetadataKey, out var raw) || string.IsNullOrEmpty(raw))
        {
            return "unknown";
        }

        try
        {
            var service = Uri.UnescapeDataString(raw);
            return string.IsNullOrEmpty(service) ? "unknown" : service;
        }
        catch (UriFormatException)
        {
            return "unknown";
        }
    }
}
