using AgentObservability.Dashboard.Models;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using System.Text.Json;

namespace AgentObservability.Dashboard.Services;

public sealed class LearningService
{
    private const string ContainerName = "ai-learnings";
    private readonly BlobContainerClient _containerClient;
    private readonly ILogger<LearningService> _logger;

    private static readonly JsonSerializerOptions _jsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        WriteIndented = true
    };

    public LearningService(BlobServiceClient blobServiceClient, ILogger<LearningService> logger)
    {
        _containerClient = blobServiceClient.GetBlobContainerClient(ContainerName);
        _logger = logger;
    }

    public async Task EnsureContainerExistsAsync()
    {
        await _containerClient.CreateIfNotExistsAsync();
    }

    public async Task<List<AiLearning>> GetAllLearningsAsync(CancellationToken cancellationToken = default)
    {
        var learnings = new List<AiLearning>();

        try
        {
            await foreach (var blobItem in _containerClient.GetBlobsAsync(cancellationToken: cancellationToken))
            {
                try
                {
                    var blobClient = _containerClient.GetBlobClient(blobItem.Name);
                    var response = await blobClient.DownloadContentAsync(cancellationToken);
                    var learning = JsonSerializer.Deserialize<AiLearning>(response.Value.Content.ToString(), _jsonOptions);
                    if (learning is not null)
                    {
                        learnings.Add(learning);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to deserialize learning blob: {BlobName}", blobItem.Name);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to list learnings from blob storage");
        }

        return learnings.OrderByDescending(l => l.CreatedAt).ToList();
    }

    public async Task SaveLearningAsync(AiLearning learning, CancellationToken cancellationToken = default)
    {
        var blobName = $"{learning.Id}.json";
        var blobClient = _containerClient.GetBlobClient(blobName);
        var json = JsonSerializer.Serialize(learning, _jsonOptions);

        await blobClient.UploadAsync(
            BinaryData.FromString(json),
            new BlobUploadOptions { HttpHeaders = new BlobHttpHeaders { ContentType = "application/json" } },
            cancellationToken);

        _logger.LogInformation("Saved AI learning: {LearningId} - {Title}", learning.Id, learning.Title);
    }

    public async Task DeleteLearningAsync(string id, CancellationToken cancellationToken = default)
    {
        var blobName = $"{id}.json";
        var blobClient = _containerClient.GetBlobClient(blobName);
        await blobClient.DeleteIfExistsAsync(cancellationToken: cancellationToken);
        _logger.LogInformation("Deleted AI learning: {LearningId}", id);
    }
}
