namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// A stored API-key record. Carries only the public lookup handle, the org the key maps to, the
/// salted/peppered secret hash, the algorithm tag, and status. The plaintext key is never stored.
/// </summary>
public sealed record ApiKeyRecord
{
    public required string KeyId { get; init; }

    /// <summary>Authoritative organization for this key. Used to stamp persisted rows; never from the body.</summary>
    public required string OrgId { get; init; }

    /// <summary>Lowercase hex of <c>HMAC-SHA256(pepper, secret)</c>.</summary>
    public required string SecretHashHex { get; init; }

    /// <summary>Hash/KDF identifier for future migration (e.g. "HMAC-SHA256").</summary>
    public string Algo { get; init; } = IngestionAuthenticator.AlgoHmacSha256;

    /// <summary>'active' enables the key; anything else (e.g. 'revoked') disables it.</summary>
    public string Status { get; init; } = "active";

    public bool IsActive => string.Equals(Status, "active", StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// Looks up a single candidate <see cref="ApiKeyRecord"/> by its public <c>keyId</c>. The keyId
/// lookup is NOT the security boundary — the secret hash comparison in
/// <see cref="IngestionAuthenticator"/> is. Returns null when no record exists.
/// </summary>
public interface IApiKeyStore
{
    Task<ApiKeyRecord?> FindByKeyIdAsync(string keyId, CancellationToken cancellationToken = default);
}
