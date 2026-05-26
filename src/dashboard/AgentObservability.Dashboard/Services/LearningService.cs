using AgentObservability.Dashboard.Models;
using Azure.Storage.Blobs;
using Azure.Storage.Blobs.Models;
using System.Text;
using System.Text.Json;

namespace AgentObservability.Dashboard.Services;

public sealed class LearningService
{
    private const string ContainerName = "ai-learnings";
    private readonly BlobContainerClient _containerClient;
    private readonly EmbeddingService _embeddingService;
    private readonly ILogger<LearningService> _logger;

    public LearningService(BlobServiceClient blobServiceClient, EmbeddingService embeddingService, ILogger<LearningService> logger)
    {
        _containerClient = blobServiceClient.GetBlobContainerClient(ContainerName);
        _embeddingService = embeddingService;
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
                    var markdown = response.Value.Content.ToString();
                    var learning = ParseMarkdown(markdown);
                    if (learning is not null)
                    {
                        learnings.Add(learning);
                    }
                }
                catch (Exception ex)
                {
                    _logger.LogWarning(ex, "Failed to parse learning blob: {BlobName}", blobItem.Name);
                }
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to list learnings from blob storage");
        }

        return learnings.OrderByDescending(l => l.UpdatedAt ?? l.CreatedAt).ToList();
    }

    public async Task<PagedResult<AiLearning>> GetPagedLearningsAsync(string? searchQuery, int page, int pageSize, CancellationToken cancellationToken = default)
    {
        var allLearnings = await GetAllLearningsAsync(cancellationToken);
        IEnumerable<AiLearning> sorted;

        if (!string.IsNullOrWhiteSpace(searchQuery))
        {
            var queryEmbedding = await _embeddingService.GenerateEmbeddingAsync(searchQuery, cancellationToken);

            if (queryEmbedding is not null)
            {
                const double similarityThreshold = 0.3;

                // Rank by cosine similarity, exclude learnings below threshold
                sorted = allLearnings
                    .Select(l => (Learning: l, Score: l.Embedding is not null ? EmbeddingService.CosineSimilarity(queryEmbedding, l.Embedding) : 0.0))
                    .Where(x => x.Score >= similarityThreshold)
                    .OrderByDescending(x => x.Score)
                    .Select(x => x.Learning);
            }
            else
            {
                // Fallback: basic substring match across all fields
                var query = searchQuery.Trim();
                sorted = allLearnings
                    .Where(l => l.GetSearchableText().Contains(query, StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(l => l.UpdatedAt ?? l.CreatedAt);
            }
        }
        else
        {
            sorted = allLearnings.OrderByDescending(l => l.UpdatedAt ?? l.CreatedAt);
        }

        var filtered = sorted.ToList();
        var items = filtered.Skip((page - 1) * pageSize).Take(pageSize).ToList();

        return new PagedResult<AiLearning>
        {
            Items = items,
            TotalCount = filtered.Count,
            Page = page,
            PageSize = pageSize
        };
    }

    public async Task BackfillEmbeddingsAsync(CancellationToken cancellationToken = default)
    {
        var learnings = await GetAllLearningsAsync(cancellationToken);
        var withoutEmbeddings = learnings.Where(l => l.Embedding is null).ToList();

        if (withoutEmbeddings.Count == 0)
            return;

        _logger.LogInformation("Backfilling embeddings for {Count} learnings", withoutEmbeddings.Count);

        foreach (var learning in withoutEmbeddings)
        {
            var embedding = await _embeddingService.GenerateEmbeddingAsync(learning.GetSearchableText(), cancellationToken);
            if (embedding is not null)
            {
                learning.Embedding = embedding;
                await SaveBlobAsync(learning, cancellationToken);
                _logger.LogInformation("Backfilled embedding for learning: {LearningId}", learning.Id);
            }
        }
    }

    public async Task SaveLearningAsync(AiLearning learning, CancellationToken cancellationToken = default)
    {
        learning.Embedding = await _embeddingService.GenerateEmbeddingAsync(learning.GetSearchableText(), cancellationToken);
        await SaveBlobAsync(learning, cancellationToken);
        _logger.LogInformation("Saved AI learning: {LearningId} - {Title}", learning.Id, learning.Title);
    }

    public async Task UpdateLearningAsync(AiLearning learning, CancellationToken cancellationToken = default)
    {
        learning.UpdatedAt = DateTimeOffset.UtcNow;
        learning.Embedding = await _embeddingService.GenerateEmbeddingAsync(learning.GetSearchableText(), cancellationToken);
        await SaveBlobAsync(learning, cancellationToken);

        // Clean up old .json blob if it exists (migration from previous format)
        var oldBlobClient = _containerClient.GetBlobClient($"{learning.Id}.json");
        await oldBlobClient.DeleteIfExistsAsync(cancellationToken: cancellationToken);

        _logger.LogInformation("Updated AI learning: {LearningId} - {Title}", learning.Id, learning.Title);
    }

    private async Task SaveBlobAsync(AiLearning learning, CancellationToken cancellationToken)
    {
        var blobName = $"{learning.Id}.md";
        var blobClient = _containerClient.GetBlobClient(blobName);
        var markdown = ToMarkdown(learning);

        await blobClient.UploadAsync(
            BinaryData.FromString(markdown),
            new BlobUploadOptions
            {
                HttpHeaders = new BlobHttpHeaders { ContentType = "text/markdown" },
                Conditions = null // overwrite
            },
            cancellationToken);
    }

    public async Task DeleteLearningAsync(string id, CancellationToken cancellationToken = default)
    {
        var mdClient = _containerClient.GetBlobClient($"{id}.md");
        await mdClient.DeleteIfExistsAsync(cancellationToken: cancellationToken);

        // Also clean up old .json format if present
        var jsonClient = _containerClient.GetBlobClient($"{id}.json");
        await jsonClient.DeleteIfExistsAsync(cancellationToken: cancellationToken);

        _logger.LogInformation("Deleted AI learning: {LearningId}", id);
    }

    public async Task<List<AiLearning>> GetLearningsByIdsAsync(IEnumerable<string> ids, CancellationToken cancellationToken = default)
    {
        var learnings = new List<AiLearning>();

        foreach (var id in ids)
        {
            try
            {
                var blobClient = _containerClient.GetBlobClient($"{id}.md");
                var response = await blobClient.DownloadContentAsync(cancellationToken);
                var markdown = response.Value.Content.ToString();
                var learning = ParseMarkdown(markdown);
                if (learning is not null)
                {
                    learnings.Add(learning);
                }
            }
            catch (Azure.RequestFailedException ex) when (ex.Status == 404)
            {
                _logger.LogWarning("Learning blob not found: {LearningId}", id);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to load learning: {LearningId}", id);
            }
        }

        return learnings;
    }

    private static string ToMarkdown(AiLearning learning)
    {
        var sb = new StringBuilder();
        sb.AppendLine("---");
        sb.AppendLine($"id: {learning.Id}");
        sb.AppendLine($"title: {EscapeYaml(learning.Title)}");
        sb.AppendLine($"description: {EscapeYaml(learning.Description)}");
        sb.AppendLine($"createdAt: {learning.CreatedAt:O}");
        if (learning.UpdatedAt.HasValue)
        {
            sb.AppendLine($"updatedAt: {learning.UpdatedAt.Value:O}");
        }
        if (learning.Embedding is not null)
        {
            sb.AppendLine($"embedding: {JsonSerializer.Serialize(learning.Embedding)}");
        }
        sb.AppendLine("---");
        sb.AppendLine();
        sb.AppendLine(learning.RuleText);

        if (!string.IsNullOrEmpty(learning.KqlExample))
        {
            sb.AppendLine();
            sb.AppendLine("```kql");
            sb.AppendLine(learning.KqlExample);
            sb.AppendLine("```");
        }

        return sb.ToString();
    }

    private static AiLearning? ParseMarkdown(string markdown)
    {
        if (!markdown.StartsWith("---"))
            return null;

        var endOfFrontmatter = markdown.IndexOf("---", 3, StringComparison.Ordinal);
        if (endOfFrontmatter < 0)
            return null;

        var frontmatter = markdown[3..endOfFrontmatter].Trim();
        var body = markdown[(endOfFrontmatter + 3)..].Trim();

        var learning = new AiLearning();

        foreach (var line in frontmatter.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var colonIdx = line.IndexOf(':');
            if (colonIdx < 0) continue;

            var key = line[..colonIdx].Trim();
            var value = UnescapeYaml(line[(colonIdx + 1)..].Trim());

            switch (key)
            {
                case "id": learning.Id = value; break;
                case "title": learning.Title = value; break;
                case "description": learning.Description = value; break;
                case "createdAt" when DateTimeOffset.TryParse(value, out var dt): learning.CreatedAt = dt; break;
                case "updatedAt" when DateTimeOffset.TryParse(value, out var udt): learning.UpdatedAt = udt; break;
                case "embedding":
                    try { learning.Embedding = JsonSerializer.Deserialize<float[]>(value); }
                    catch { /* ignore malformed embedding */ }
                    break;
            }
        }

        // Parse body: rule text is everything before a ```kql block; KQL example is inside it
        var kqlStart = body.IndexOf("```kql", StringComparison.OrdinalIgnoreCase);
        if (kqlStart >= 0)
        {
            learning.RuleText = body[..kqlStart].Trim();
            var codeStart = body.IndexOf('\n', kqlStart) + 1;
            var codeEnd = body.IndexOf("```", codeStart, StringComparison.Ordinal);
            if (codeEnd > codeStart)
            {
                learning.KqlExample = body[codeStart..codeEnd].Trim();
            }
        }
        else
        {
            learning.RuleText = body;
        }

        return string.IsNullOrEmpty(learning.Id) ? null : learning;
    }

    private static string EscapeYaml(string value)
    {
        if (string.IsNullOrEmpty(value)) return "\"\"";
        if (value.Contains(':') || value.Contains('#') || value.Contains('"') ||
            value.Contains('\n') || value.StartsWith(' ') || value.EndsWith(' '))
        {
            return $"\"{value.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"";
        }
        return value;
    }

    private static string UnescapeYaml(string value)
    {
        if (value.StartsWith('"') && value.EndsWith('"') && value.Length >= 2)
        {
            return value[1..^1].Replace("\\\"", "\"").Replace("\\\\", "\\");
        }
        return value;
    }
}
