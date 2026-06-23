using System.Text.Json;
using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Integration of validate + store via the host-independent handler core, with an in-memory store
/// (no live Azure). Verifies success, idempotency, raw-field rejection, 401, and 503.
/// </summary>
public sealed class IngestionPipelineTests
{
    private static readonly AggregateBatchValidator Validator = new();
    private const string OrgId = "org-7";

    // Minimal service provider so IResult.ExecuteAsync can resolve the services
    // (problem-details, logging, JSON options) that Results.Ok/Problem require.
    private static readonly IServiceProvider Services = BuildServices();

    private static IServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddProblemDetails();
        services.AddRouting();
        return services.BuildServiceProvider();
    }

    /// <summary>Executes an IResult against a throwaway HttpContext and returns the HTTP status code.</summary>
    private static async Task<int> StatusCodeOf(IResult result)
    {
        var context = new DefaultHttpContext
        {
            RequestServices = Services,
        };
        context.Response.Body = new MemoryStream();
        await result.ExecuteAsync(context);
        return context.Response.StatusCode;
    }

    [Fact]
    public async Task ValidBatchWithAuth_Returns200_AndStoresRows()
    {
        var store = new InMemoryAggregateStore();
        var auth = AuthResult.Success(OrgId);

        var result = await IngestionEndpoints.HandleAggregateAsync(auth, TestData.ValidBatchJson, Validator, store);

        Assert.Equal(StatusCodes.Status200OK, await StatusCodeOf(result));

        // Clean JSON sample has exactly one bucket.
        Assert.Equal(1, store.Count);
        Assert.All(store.Buckets, b => Assert.Equal(OrgId, b.PartitionKey));
    }

    [Fact]
    public async Task MultiBucketBatch_StoresOneRowPerBucket()
    {
        var store = new InMemoryAggregateStore();
        var batch = TestData.ValidBatch(); // two buckets
        var json = JsonSerializer.Serialize(batch, IngestionEndpoints.DisallowOptions);

        await IngestionEndpoints.HandleAggregateAsync(AuthResult.Success(OrgId), json, Validator, store);

        Assert.Equal(batch.Buckets.Count, store.Count);
    }

    [Fact]
    public async Task SameBatchTwice_IsIdempotent()
    {
        var store = new InMemoryAggregateStore();
        var auth = AuthResult.Success(OrgId);

        await IngestionEndpoints.HandleAggregateAsync(auth, TestData.ValidBatchJson, Validator, store);
        var countAfterFirst = store.Count;

        await IngestionEndpoints.HandleAggregateAsync(auth, TestData.ValidBatchJson, Validator, store);
        var countAfterSecond = store.Count;

        Assert.Equal(countAfterFirst, countAfterSecond);
    }

    [Fact]
    public async Task ForbiddenField_Returns400_AndStoresNothing()
    {
        var store = new InMemoryAggregateStore();

        var result = await IngestionEndpoints.HandleAggregateAsync(
            AuthResult.Success(OrgId), TestData.BatchJsonWithForbiddenField, Validator, store);

        Assert.Equal(StatusCodes.Status400BadRequest, await StatusCodeOf(result));
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task InvalidBatch_Returns400()
    {
        var store = new InMemoryAggregateStore();
        var badBatch = TestData.ValidBatch(TestData.ValidBucket() with { BucketDurationSeconds = 60 });
        var json = JsonSerializer.Serialize(badBatch, IngestionEndpoints.DisallowOptions);

        var result = await IngestionEndpoints.HandleAggregateAsync(AuthResult.Success(OrgId), json, Validator, store);

        Assert.Equal(StatusCodes.Status400BadRequest, await StatusCodeOf(result));
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task Unauthenticated_Returns401_AndStoresNothing()
    {
        var store = new InMemoryAggregateStore();
        var auth = AuthResult.Fail(AuthFailureReason.UnknownKey);

        var result = await IngestionEndpoints.HandleAggregateAsync(auth, TestData.ValidBatchJson, Validator, store);

        Assert.Equal(StatusCodes.Status401Unauthorized, await StatusCodeOf(result));
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task Disabled_Returns503()
    {
        // When ingestion is disabled the endpoint short-circuits before auth/store.
        var result = IngestionEndpoints.ServiceDisabled();

        Assert.Equal(StatusCodes.Status503ServiceUnavailable, await StatusCodeOf(result));
    }

    [Fact]
    public async Task StatusReport_WithAuth_IsStored()
    {
        var store = new InMemorySyncStatusStore();
        const string json = """
            {
              "schemaVersion": "1.0",
              "pseudonymousDeveloperId": "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3",
              "toolVersion": "1.4.2",
              "lastSyncAt": "2026-06-02T09:15:00Z",
              "pendingBatchCount": 0
            }
            """;

        var result = await IngestionEndpoints.HandleStatusAsync(AuthResult.Success(OrgId), json, store);

        Assert.Equal(StatusCodes.Status200OK, await StatusCodeOf(result));
        Assert.Equal(1, store.Count);
    }

    [Fact]
    public async Task StatusReport_Unauthenticated_Returns401()
    {
        var store = new InMemorySyncStatusStore();
        var result = await IngestionEndpoints.HandleStatusAsync(
            AuthResult.Fail(AuthFailureReason.MissingHeader), "{}", store);

        Assert.Equal(StatusCodes.Status401Unauthorized, await StatusCodeOf(result));
        Assert.Equal(0, store.Count);
    }
}
