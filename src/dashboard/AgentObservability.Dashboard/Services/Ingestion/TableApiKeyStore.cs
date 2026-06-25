using Azure.Data.Tables;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Azure Table Storage backed <see cref="IApiKeyStore"/>. Records live in table 'IngestionApiKeys'
/// with PartitionKey 'apikey' and RowKey = keyId, and carry only the public lookup handle plus the
/// salted/peppered secret hash (never the plaintext key).
/// </summary>
public sealed class TableApiKeyStore : IApiKeyStore
{
    public const string TableName = "IngestionApiKeys";
    public const string PartitionKeyValue = "apikey";

    private readonly TableClient _table;
    private readonly ILogger<TableApiKeyStore> _logger;

    public TableApiKeyStore(TableServiceClient tableServiceClient, ILogger<TableApiKeyStore> logger)
    {
        _table = tableServiceClient.GetTableClient(TableName);
        _logger = logger;
    }

    public async Task EnsureTablesExistAsync()
    {
        await _table.CreateIfNotExistsAsync();
    }

    public async Task<ApiKeyRecord?> FindByKeyIdAsync(string keyId, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(keyId))
        {
            return null;
        }

        try
        {
            var entity = await _table.GetEntityAsync<TableEntity>(PartitionKeyValue, keyId, cancellationToken: cancellationToken)
                .ConfigureAwait(false);

            var orgId = entity.Value.GetString("OrgId");
            var secretHashHex = entity.Value.GetString("SecretHashHex");

            if (string.IsNullOrEmpty(orgId) || string.IsNullOrEmpty(secretHashHex))
            {
                _logger.LogWarning("Ingestion API key record '{KeyId}' is missing OrgId or SecretHashHex.", keyId);
                return null;
            }

            return new ApiKeyRecord
            {
                KeyId = keyId,
                OrgId = orgId,
                SecretHashHex = secretHashHex.ToLowerInvariant(),
                Algo = entity.Value.GetString("Algo") ?? IngestionAuthenticator.AlgoHmacSha256,
                Status = entity.Value.GetString("Status") ?? "active",
            };
        }
        catch (Azure.RequestFailedException ex) when (ex.Status == 404)
        {
            return null;
        }
    }
}
