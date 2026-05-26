using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Extensions.Options;
using OpenAI.Embeddings;

namespace AgentObservability.Dashboard.Services;

public sealed class EmbeddingService
{
    private readonly EmbeddingClient _embeddingClient;
    private readonly ILogger<EmbeddingService> _logger;

    public EmbeddingService(IOptions<AzureAIOptions> options, ILogger<EmbeddingService> logger)
    {
        _logger = logger;
        var endpoint = options.Value.Endpoint;
        if (string.IsNullOrEmpty(endpoint))
        {
            throw new InvalidOperationException("AzureAI:Endpoint must be configured.");
        }

        var projectClient = new AIProjectClient(new Uri(endpoint), new DefaultAzureCredential());
        _embeddingClient = projectClient.ProjectOpenAIClient.GetEmbeddingClient(options.Value.EmbeddingDeploymentName);
    }

    public async Task<float[]?> GenerateEmbeddingAsync(string text, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(text))
            return null;

        try
        {
            var response = await _embeddingClient.GenerateEmbeddingAsync(text, cancellationToken: cancellationToken);
            return response.Value.ToFloats().ToArray();
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Failed to generate embedding");
            return null;
        }
    }

    public static double CosineSimilarity(float[] a, float[] b)
    {
        if (a.Length != b.Length)
            return 0;

        double dot = 0, normA = 0, normB = 0;
        for (int i = 0; i < a.Length; i++)
        {
            dot += a[i] * (double)b[i];
            normA += a[i] * (double)a[i];
            normB += b[i] * (double)b[i];
        }

        var denominator = Math.Sqrt(normA) * Math.Sqrt(normB);
        return denominator == 0 ? 0 : dot / denominator;
    }
}
