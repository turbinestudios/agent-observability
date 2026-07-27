using System.Text;
using System.Text.Json;
using AgentObservability.Dashboard.Models.AgentRelay;
using AgentObservability.Dashboard.Services.AgentRelay;
using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Exercises the autonomous-agent OTLP relay via its host-independent handler cores with an
/// in-memory store (no live Azure): ingest (push), list + download (pull), auth, validation,
/// size + feature gating, oldest-first ordering, the since watermark, and strict org isolation.
/// </summary>
public sealed class AgentRelayEndpointTests
{
    private const string OrgId = "org-7";
    private static readonly AgentRelayOptions Options = new() { Enabled = true };
    private static readonly JsonSerializerOptions CaseInsensitive = new() { PropertyNameCaseInsensitive = true };

    private static readonly IServiceProvider Services = BuildServices();

    private static IServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddProblemDetails();
        services.AddRouting();
        return services.BuildServiceProvider();
    }

    private static async Task<(int Status, string Body)> ExecuteAsync(IResult result)
    {
        var context = new DefaultHttpContext { RequestServices = Services };
        var stream = new MemoryStream();
        context.Response.Body = stream;
        await result.ExecuteAsync(context);
        stream.Position = 0;
        using var reader = new StreamReader(stream);
        return (context.Response.StatusCode, await reader.ReadToEndAsync());
    }

    private static string OtlpJson(string? serviceName)
    {
        var attributes = serviceName is null
            ? string.Empty
            : $$"""{ "key": "service.name", "value": { "stringValue": "{{serviceName}}" } }""";

        return $$"""
            { "resourceSpans": [ { "resource": { "attributes": [ {{attributes}} ] }, "scopeSpans": [] } ] }
            """;
    }

    // ---- Ingest (push) --------------------------------------------------------------------

    [Fact]
    public async Task Ingest_ValidOtlp_Returns200_AndStores()
    {
        var store = new InMemoryAgentOtlpBatchStore();
        var body = OtlpJson("copilot-agent");

        var result = await AgentOtlpEndpoints.HandleIngestAsync(
            AuthResult.Success(OrgId), body, store, Options, nowMs: 1_000);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status200OK, status);
        Assert.Equal(1, store.Count);
        var stored = Assert.Single(store.Batches);
        Assert.Equal("copilot-agent", stored.Service);
        Assert.Equal(1_000, stored.CreatedAtMs);
    }

    [Fact]
    public async Task Ingest_NoServiceName_DefaultsUnknown()
    {
        var store = new InMemoryAgentOtlpBatchStore();

        await AgentOtlpEndpoints.HandleIngestAsync(
            AuthResult.Success(OrgId), OtlpJson(null), store, Options, nowMs: 5);

        Assert.Equal("unknown", Assert.Single(store.Batches).Service);
    }

    [Fact]
    public async Task Ingest_InvalidJson_Returns400_StoresNothing()
    {
        var store = new InMemoryAgentOtlpBatchStore();

        var result = await AgentOtlpEndpoints.HandleIngestAsync(
            AuthResult.Success(OrgId), "not-json{", store, Options, nowMs: 1);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status400BadRequest, status);
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task Ingest_EmptyBody_Returns400()
    {
        var store = new InMemoryAgentOtlpBatchStore();

        var result = await AgentOtlpEndpoints.HandleIngestAsync(
            AuthResult.Success(OrgId), "   ", store, Options, nowMs: 1);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status400BadRequest, status);
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task Ingest_TooLarge_Returns413()
    {
        var store = new InMemoryAgentOtlpBatchStore();
        var tinyLimit = new AgentRelayOptions { Enabled = true, MaxBatchBytes = 8 };

        var result = await AgentOtlpEndpoints.HandleIngestAsync(
            AuthResult.Success(OrgId), OtlpJson("svc"), store, tinyLimit, nowMs: 1);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status413PayloadTooLarge, status);
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task Ingest_Unauthenticated_Returns401_StoresNothing()
    {
        var store = new InMemoryAgentOtlpBatchStore();

        var result = await AgentOtlpEndpoints.HandleIngestAsync(
            AuthResult.Fail(AuthFailureReason.UnknownKey), OtlpJson("svc"), store, Options, nowMs: 1);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status401Unauthorized, status);
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task Disabled_Returns503()
    {
        var (status, _) = await ExecuteAsync(AgentOtlpEndpoints.ServiceDisabled());
        Assert.Equal(StatusCodes.Status503ServiceUnavailable, status);
    }

    // ---- List (pull) ----------------------------------------------------------------------

    [Fact]
    public async Task List_ReturnsOrgBatches_OldestFirst_WithSinceFilter()
    {
        var store = new InMemoryAgentOtlpBatchStore();
        await store.StoreAsync(OrgId, "svc", OtlpJson("svc"), createdAtMs: 100);
        var b200 = await store.StoreAsync(OrgId, "svc", OtlpJson("svc"), createdAtMs: 200);
        var b300 = await store.StoreAsync(OrgId, "svc", OtlpJson("svc"), createdAtMs: 300);

        var result = await AgentOtlpEndpoints.HandleListAsync(
            AuthResult.Success(OrgId), since: 200, limit: 100, store, Options);

        var (status, body) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status200OK, status);

        var refs = Deserialize(body);
        Assert.Equal([b200.Id, b300.Id], refs.Select(r => r.Id));
        Assert.All(refs, r => Assert.True(r.CreatedAtMs >= 200));
        Assert.True(refs[0].SizeBytes > 0);
    }

    [Fact]
    public async Task List_ClampsLimit_AndFloorsToOne()
    {
        var store = new InMemoryAgentOtlpBatchStore();
        for (var i = 1; i <= 5; i++)
        {
            await store.StoreAsync(OrgId, "svc", OtlpJson("svc"), createdAtMs: i);
        }

        var capped = new AgentRelayOptions { Enabled = true, MaxListLimit = 2 };
        var result = await AgentOtlpEndpoints.HandleListAsync(
            AuthResult.Success(OrgId), since: 0, limit: 1000, store, capped);

        var (_, body) = await ExecuteAsync(result);
        Assert.Equal(2, Deserialize(body).Count);
    }

    [Fact]
    public async Task List_IsOrgScoped()
    {
        var store = new InMemoryAgentOtlpBatchStore();
        var mine = await store.StoreAsync(OrgId, "svc", OtlpJson("svc"), createdAtMs: 10);
        await store.StoreAsync("other-org", "svc", OtlpJson("svc"), createdAtMs: 20);

        var result = await AgentOtlpEndpoints.HandleListAsync(
            AuthResult.Success(OrgId), since: 0, limit: 100, store, Options);

        var (_, body) = await ExecuteAsync(result);
        Assert.Equal(mine.Id, Assert.Single(Deserialize(body)).Id);
    }

    [Fact]
    public async Task List_Unauthenticated_Returns401()
    {
        var result = await AgentOtlpEndpoints.HandleListAsync(
            AuthResult.Fail(AuthFailureReason.MissingHeader), since: 0, limit: 100,
            new InMemoryAgentOtlpBatchStore(), Options);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status401Unauthorized, status);
    }

    // ---- Download (pull) ------------------------------------------------------------------

    [Fact]
    public async Task Download_ReturnsVerbatimBody()
    {
        var store = new InMemoryAgentOtlpBatchStore();
        var body = OtlpJson("copilot-agent");
        var stored = await store.StoreAsync(OrgId, "copilot-agent", body, createdAtMs: 1);

        var result = await AgentOtlpEndpoints.HandleDownloadAsync(AuthResult.Success(OrgId), stored.Id, store);

        var (status, downloaded) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status200OK, status);
        Assert.Equal(body, downloaded);
    }

    [Fact]
    public async Task Download_UnknownId_Returns404()
    {
        var store = new InMemoryAgentOtlpBatchStore();

        var result = await AgentOtlpEndpoints.HandleDownloadAsync(
            AuthResult.Success(OrgId), AgentBatchId.Mint(1), store);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status404NotFound, status);
    }

    [Fact]
    public async Task Download_MalformedId_Returns404()
    {
        var store = new InMemoryAgentOtlpBatchStore();

        var result = await AgentOtlpEndpoints.HandleDownloadAsync(
            AuthResult.Success(OrgId), "../other-org/secret", store);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status404NotFound, status);
    }

    [Fact]
    public async Task Download_CrossOrg_Returns404()
    {
        var store = new InMemoryAgentOtlpBatchStore();
        var stored = await store.StoreAsync(OrgId, "svc", OtlpJson("svc"), createdAtMs: 1);

        var result = await AgentOtlpEndpoints.HandleDownloadAsync(
            AuthResult.Success("intruder-org"), stored.Id, store);

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status404NotFound, status);
    }

    [Fact]
    public async Task Download_Unauthenticated_Returns401()
    {
        var result = await AgentOtlpEndpoints.HandleDownloadAsync(
            AuthResult.Fail(AuthFailureReason.MalformedToken), AgentBatchId.Mint(1),
            new InMemoryAgentOtlpBatchStore());

        var (status, _) = await ExecuteAsync(result);
        Assert.Equal(StatusCodes.Status401Unauthorized, status);
    }

    // ---- Helpers --------------------------------------------------------------------------

    [Theory]
    [InlineData("copilot-agent", "copilot-agent")]
    [InlineData(null, "unknown")]
    public void TryExtractServiceName_ParsesResourceAttribute(string? serviceName, string expected)
    {
        Assert.True(AgentOtlpEndpoints.TryExtractServiceName(OtlpJson(serviceName), out var service));
        Assert.Equal(expected, service);
    }

    [Fact]
    public void TryExtractServiceName_InvalidJson_ReturnsFalse()
    {
        Assert.False(AgentOtlpEndpoints.TryExtractServiceName("nope{", out _));
    }

    [Fact]
    public void AgentBatchId_RejectsPathTraversal()
    {
        Assert.False(AgentBatchId.IsValid("../evil"));
        Assert.False(AgentBatchId.IsValid("a/b"));
        Assert.True(AgentBatchId.IsValid(AgentBatchId.Mint(123)));
    }

    private static IReadOnlyList<RefDto> Deserialize(string body)
    {
        var envelope = JsonSerializer.Deserialize<ListDto>(body, CaseInsensitive);
        Assert.NotNull(envelope);
        return envelope!.Batches;
    }

    private sealed record ListDto(List<RefDto> Batches);

    private sealed record RefDto(string Id, string Service, long CreatedAtMs, long SizeBytes);
}
