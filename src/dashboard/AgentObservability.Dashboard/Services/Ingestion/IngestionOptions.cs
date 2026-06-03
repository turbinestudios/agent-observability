namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Configuration for the cloud ingestion API ('Ingestion' section). Bound from appsettings.
/// </summary>
public sealed class IngestionOptions
{
    public const string SectionName = "Ingestion";

    /// <summary>
    /// Master switch for the ingestion endpoints. When false, <c>POST /api/ingest/*</c> return 503
    /// (the health endpoint still answers, reporting <c>enabled=false</c>). Default true.
    /// </summary>
    public bool Enabled { get; set; } = true;

    /// <summary>
    /// Server-side pepper used to compute <c>HMAC-SHA256(pepper, secret)</c> for API-key secrets.
    /// Held only in configuration / Key Vault, never in the key store rows, so a DB-only leak does
    /// not enable offline brute force.
    /// </summary>
    public string KeyPepper { get; set; } = string.Empty;

    /// <summary>
    /// Config-backed API keys. Used by <see cref="ConfigApiKeyStore"/> when no Table storage is wired.
    /// </summary>
    public IList<ApiKeyConfig> ApiKeys { get; set; } = [];
}

/// <summary>
/// One configured API key. Provide EITHER a precomputed <see cref="SecretHashHex"/> (production)
/// OR a plaintext <see cref="Secret"/> (dev-only; hashed in-memory at startup, with a warning).
/// </summary>
public sealed class ApiKeyConfig
{
    /// <summary>Public, non-secret lookup handle (the <c>keyId</c> from <c>aoa_&lt;keyId&gt;_&lt;secret&gt;</c>).</summary>
    public string KeyId { get; set; } = string.Empty;

    /// <summary>Organization this key authenticates as. Derived server-side; never trusted from the payload.</summary>
    public string OrgId { get; set; } = string.Empty;

    /// <summary>Lowercase hex of <c>HMAC-SHA256(pepper, secret)</c>. Preferred for non-dev configs.</summary>
    public string? SecretHashHex { get; set; }

    /// <summary>DEV ONLY: plaintext secret, hashed in-memory at construction with the configured pepper.</summary>
    public string? Secret { get; set; }

    /// <summary>Key status; 'revoked' (or anything other than 'active') disables the key.</summary>
    public string Status { get; set; } = "active";
}
