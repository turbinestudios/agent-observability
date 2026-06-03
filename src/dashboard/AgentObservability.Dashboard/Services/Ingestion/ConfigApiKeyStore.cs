using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Configuration-backed <see cref="IApiKeyStore"/>. Reads <see cref="IngestionOptions.ApiKeys"/>.
/// Each entry supplies either a precomputed <c>SecretHashHex</c> (production) or a dev-only
/// plaintext <c>Secret</c> which is hashed in-memory at construction with the configured pepper.
/// A warning is logged whenever a plaintext secret is used, since that mode is intended for local
/// development only.
/// </summary>
public sealed class ConfigApiKeyStore : IApiKeyStore
{
    private readonly Dictionary<string, ApiKeyRecord> _records;

    public ConfigApiKeyStore(IOptions<IngestionOptions> options, ILogger<ConfigApiKeyStore> logger)
    {
        var opts = options.Value;
        _records = new Dictionary<string, ApiKeyRecord>(StringComparer.Ordinal);

        foreach (var key in opts.ApiKeys ?? [])
        {
            if (string.IsNullOrWhiteSpace(key.KeyId) || string.IsNullOrWhiteSpace(key.OrgId))
            {
                logger.LogWarning("Skipping ingestion ApiKey config entry with missing KeyId or OrgId.");
                continue;
            }

            string secretHashHex;
            if (!string.IsNullOrWhiteSpace(key.SecretHashHex))
            {
                secretHashHex = key.SecretHashHex.Trim().ToLowerInvariant();
            }
            else if (!string.IsNullOrWhiteSpace(key.Secret))
            {
                logger.LogWarning(
                    "Ingestion ApiKey '{KeyId}' is configured with a PLAINTEXT Secret. This is DEV-ONLY; " +
                    "use a precomputed SecretHashHex in non-development environments.", key.KeyId);
                secretHashHex = IngestionAuthenticator.ComputeSecretHashHex(opts.KeyPepper ?? string.Empty, key.Secret);
            }
            else
            {
                logger.LogWarning("Skipping ingestion ApiKey '{KeyId}' with neither SecretHashHex nor Secret.", key.KeyId);
                continue;
            }

            _records[key.KeyId] = new ApiKeyRecord
            {
                KeyId = key.KeyId,
                OrgId = key.OrgId,
                SecretHashHex = secretHashHex,
                Algo = IngestionAuthenticator.AlgoHmacSha256,
                Status = string.IsNullOrWhiteSpace(key.Status) ? "active" : key.Status,
            };
        }
    }

    public Task<ApiKeyRecord?> FindByKeyIdAsync(string keyId, CancellationToken cancellationToken = default)
    {
        _records.TryGetValue(keyId, out var record);
        return Task.FromResult(record);
    }
}
