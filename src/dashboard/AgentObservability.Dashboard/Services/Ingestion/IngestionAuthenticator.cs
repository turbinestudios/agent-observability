using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Why authentication failed. All values map to HTTP 401 and are kept indistinguishable in the
/// response so a caller cannot enumerate valid keyIds. The distinction exists for server-side
/// logging/diagnostics only.
/// </summary>
public enum AuthFailureReason
{
    None = 0,
    MissingHeader,
    MalformedToken,
    UnknownKey,
    InvalidSecret,
    DisabledKey,
}

/// <summary>
/// Result of authenticating an ingestion request. On success, <see cref="OrgId"/> is the
/// organization derived from the KEY RECORD — never from the request payload.
/// </summary>
public sealed record AuthResult
{
    public bool IsAuthenticated { get; private init; }

    public string? OrgId { get; private init; }

    public AuthFailureReason FailureReason { get; private init; }

    public static AuthResult Success(string orgId) => new()
    {
        IsAuthenticated = true,
        OrgId = orgId,
        FailureReason = AuthFailureReason.None,
    };

    public static AuthResult Fail(AuthFailureReason reason) => new()
    {
        IsAuthenticated = false,
        OrgId = null,
        FailureReason = reason,
    };
}

/// <summary>
/// Validates the <c>Authorization: Bearer aoa_&lt;keyId&gt;_&lt;secret&gt;</c> header per
/// <c>docs/architecture/api-auth.md</c>: parse the token, look up the candidate record by the
/// public keyId, recompute <c>HMAC-SHA256(pepper, secret)</c>, and compare against the stored hash
/// using a constant-time comparison. The orgId is taken from the matched record.
///
/// Every failure path returns 401 at the HTTP layer and the outcomes are kept indistinguishable
/// (no different latency/body for "unknown keyId" vs "wrong secret"). To avoid leaking whether a
/// keyId exists, the authenticator runs a dummy HMAC even when no record is found.
/// </summary>
public sealed class IngestionAuthenticator
{
    public const string AlgoHmacSha256 = "HMAC-SHA256";
    private const string BearerPrefix = "Bearer ";
    private const string TokenPrefix = "aoa_";

    private readonly IApiKeyStore _keyStore;
    private readonly byte[] _pepper;

    public IngestionAuthenticator(IApiKeyStore keyStore, IOptions<IngestionOptions> options)
    {
        _keyStore = keyStore;
        _pepper = Encoding.UTF8.GetBytes(options.Value.KeyPepper ?? string.Empty);
    }

    /// <summary>
    /// Computes the canonical lowercase-hex secret hash for a plaintext secret and pepper.
    /// Exposed so <see cref="ConfigApiKeyStore"/> can hash dev-only plaintext secrets at startup
    /// with the same primitive used during validation.
    /// </summary>
    public static string ComputeSecretHashHex(string pepper, string secret)
    {
        using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(pepper ?? string.Empty));
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(secret ?? string.Empty));
        return Convert.ToHexStringLower(hash);
    }

    public async Task<AuthResult> AuthenticateAsync(string? authorizationHeader, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(authorizationHeader))
        {
            return AuthResult.Fail(AuthFailureReason.MissingHeader);
        }

        if (!authorizationHeader.StartsWith(BearerPrefix, StringComparison.Ordinal))
        {
            return AuthResult.Fail(AuthFailureReason.MalformedToken);
        }

        var token = authorizationHeader[BearerPrefix.Length..].Trim();
        if (!TryParseToken(token, out var keyId, out var secret))
        {
            return AuthResult.Fail(AuthFailureReason.MalformedToken);
        }

        var record = await _keyStore.FindByKeyIdAsync(keyId, cancellationToken).ConfigureAwait(false);

        if (record is null)
        {
            // Run a dummy comparison so the unknown-key path costs roughly the same as the
            // known-key path (mitigates timing-based keyId enumeration).
            _ = FixedTimeEqualsHex(ComputeSecretHashHex2(secret), ComputeSecretHashHex2("\0dummy"));
            return AuthResult.Fail(AuthFailureReason.UnknownKey);
        }

        var presentedHashHex = ComputeSecretHashHex2(secret);
        if (!FixedTimeEqualsHex(presentedHashHex, record.SecretHashHex))
        {
            return AuthResult.Fail(AuthFailureReason.InvalidSecret);
        }

        if (!record.IsActive)
        {
            return AuthResult.Fail(AuthFailureReason.DisabledKey);
        }

        return AuthResult.Success(record.OrgId);
    }

    private string ComputeSecretHashHex2(string secret)
    {
        using var hmac = new HMACSHA256(_pepper);
        var hash = hmac.ComputeHash(Encoding.UTF8.GetBytes(secret));
        return Convert.ToHexStringLower(hash);
    }

    private static bool TryParseToken(string token, out string keyId, out string secret)
    {
        keyId = string.Empty;
        secret = string.Empty;

        if (string.IsNullOrEmpty(token) || !token.StartsWith(TokenPrefix, StringComparison.Ordinal))
        {
            return false;
        }

        // Format: aoa_<keyId>_<secret>. keyId is a single segment; the secret is everything after
        // the second underscore (the secret's own encoding never contains '_').
        var rest = token[TokenPrefix.Length..];
        var underscore = rest.IndexOf('_');
        if (underscore <= 0 || underscore == rest.Length - 1)
        {
            return false;
        }

        keyId = rest[..underscore];
        secret = rest[(underscore + 1)..];
        return keyId.Length > 0 && secret.Length > 0;
    }

    private static bool FixedTimeEqualsHex(string a, string b)
    {
        // Compare the raw UTF-8 bytes of the equal-length hex strings in constant time.
        // FixedTimeEquals already short-circuits to false on a length mismatch without leaking
        // position, which is fine here since both inputs are fixed-width hex of the same hash.
        return CryptographicOperations.FixedTimeEquals(
            Encoding.ASCII.GetBytes(a),
            Encoding.ASCII.GetBytes(b));
    }
}
