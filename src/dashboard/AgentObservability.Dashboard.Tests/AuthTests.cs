using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

public sealed class AuthTests
{
    private const string Pepper = "test-pepper";
    private const string KeyId = "k1";
    private const string Secret = "the-secret-segment";
    private const string OrgId = "org-42";

    private static IngestionAuthenticator BuildAuthenticator(string status = "active")
    {
        var options = Options.Create(new IngestionOptions
        {
            Enabled = true,
            KeyPepper = Pepper,
            ApiKeys =
            [
                new ApiKeyConfig { KeyId = KeyId, OrgId = OrgId, Secret = Secret, Status = status },
            ],
        });

        var store = new ConfigApiKeyStore(options, NullLogger<ConfigApiKeyStore>.Instance);
        return new IngestionAuthenticator(store, options);
    }

    [Fact]
    public async Task ValidKeyAndSecret_ReturnsOrgId()
    {
        var auth = BuildAuthenticator();
        var result = await auth.AuthenticateAsync($"Bearer aoa_{KeyId}_{Secret}");

        Assert.True(result.IsAuthenticated);
        Assert.Equal(OrgId, result.OrgId);
    }

    [Fact]
    public async Task WrongSecret_Fails()
    {
        var auth = BuildAuthenticator();
        var result = await auth.AuthenticateAsync($"Bearer aoa_{KeyId}_wrong-secret");

        Assert.False(result.IsAuthenticated);
        Assert.Equal(AuthFailureReason.InvalidSecret, result.FailureReason);
        Assert.Null(result.OrgId);
    }

    [Fact]
    public async Task UnknownKeyId_Fails()
    {
        var auth = BuildAuthenticator();
        var result = await auth.AuthenticateAsync($"Bearer aoa_nope_{Secret}");

        Assert.False(result.IsAuthenticated);
        Assert.Equal(AuthFailureReason.UnknownKey, result.FailureReason);
    }

    [Fact]
    public async Task MissingHeader_Fails()
    {
        var auth = BuildAuthenticator();
        var result = await auth.AuthenticateAsync(null);

        Assert.False(result.IsAuthenticated);
        Assert.Equal(AuthFailureReason.MissingHeader, result.FailureReason);
    }

    [Theory]
    [InlineData("garbage")]
    [InlineData("Bearer")]
    [InlineData("Bearer not-a-token")]
    [InlineData("Bearer aoa_onlykeyid")] // no secret segment
    [InlineData("Basic aoa_k1_secret")] // wrong scheme
    public async Task GarbledHeader_Fails(string header)
    {
        var auth = BuildAuthenticator();
        var result = await auth.AuthenticateAsync(header);

        Assert.False(result.IsAuthenticated);
    }

    [Fact]
    public async Task RevokedKey_Fails()
    {
        var auth = BuildAuthenticator(status: "revoked");
        var result = await auth.AuthenticateAsync($"Bearer aoa_{KeyId}_{Secret}");

        Assert.False(result.IsAuthenticated);
        Assert.Equal(AuthFailureReason.DisabledKey, result.FailureReason);
    }

    [Fact]
    public async Task PrecomputedSecretHash_Works()
    {
        var hashHex = IngestionAuthenticator.ComputeSecretHashHex(Pepper, Secret);
        var options = Options.Create(new IngestionOptions
        {
            KeyPepper = Pepper,
            ApiKeys = [new ApiKeyConfig { KeyId = KeyId, OrgId = OrgId, SecretHashHex = hashHex }],
        });
        var store = new ConfigApiKeyStore(options, NullLogger<ConfigApiKeyStore>.Instance);
        var auth = new IngestionAuthenticator(store, options);

        var result = await auth.AuthenticateAsync($"Bearer aoa_{KeyId}_{Secret}");

        Assert.True(result.IsAuthenticated);
        Assert.Equal(OrgId, result.OrgId);
    }
}
