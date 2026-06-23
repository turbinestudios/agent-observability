using System.Text.Json;
using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Integration of validate + store for the context-insights endpoint via the host-independent
/// handler core, with an in-memory store (no live Azure). Verifies success, idempotency, structural
/// raw-field rejection, server-side path validation, and 401.
/// </summary>
public sealed class ContextInsightsIngestionTests
{
    private static readonly ContextInsightsBatchValidator Validator = new();
    private const string OrgId = "org-7";

    private static readonly IServiceProvider Services = BuildServices();

    private static IServiceProvider BuildServices()
    {
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddProblemDetails();
        services.AddRouting();
        return services.BuildServiceProvider();
    }

    private static async Task<int> StatusCodeOf(IResult result)
    {
        var context = new DefaultHttpContext { RequestServices = Services };
        context.Response.Body = new MemoryStream();
        await result.ExecuteAsync(context);
        return context.Response.StatusCode;
    }

    [Fact]
    public async Task ValidBatchWithAuth_Returns200_AndStoresRows()
    {
        var store = new InMemoryContextInsightStore();
        var auth = AuthResult.Success(OrgId);

        var result = await IngestionEndpoints.HandleContextInsightsAsync(
            auth, ContextInsightsTestData.ValidBatchJson, Validator, store);

        Assert.Equal(StatusCodes.Status200OK, await StatusCodeOf(result));
        Assert.Equal(1, store.Count);
        Assert.All(store.Rows, r => Assert.Equal(OrgId, r.PartitionKey));
    }

    [Fact]
    public async Task SameBatchTwice_IsIdempotent()
    {
        var store = new InMemoryContextInsightStore();
        var auth = AuthResult.Success(OrgId);

        await IngestionEndpoints.HandleContextInsightsAsync(auth, ContextInsightsTestData.ValidBatchJson, Validator, store);
        var countAfterFirst = store.Count;

        await IngestionEndpoints.HandleContextInsightsAsync(auth, ContextInsightsTestData.ValidBatchJson, Validator, store);
        var countAfterSecond = store.Count;

        Assert.Equal(countAfterFirst, countAfterSecond);
    }

    [Fact]
    public async Task MultiRowBatch_StoresOneRowPerEntry()
    {
        var store = new InMemoryContextInsightStore();
        var batch = ContextInsightsTestData.ValidBatch(
            ContextInsightsTestData.ValidRow("ctx-row-1"),
            ContextInsightsTestData.ValidRow("ctx-row-2", ".github/prompts/refactor.prompt.md", "prompt"));
        var json = JsonSerializer.Serialize(batch, IngestionEndpoints.DisallowOptions);

        await IngestionEndpoints.HandleContextInsightsAsync(AuthResult.Success(OrgId), json, Validator, store);

        Assert.Equal(batch.Rows.Count, store.Count);
    }

    [Fact]
    public async Task ForbiddenRawSkipReasonField_Returns400_AndStoresNothing()
    {
        var store = new InMemoryContextInsightStore();

        var result = await IngestionEndpoints.HandleContextInsightsAsync(
            AuthResult.Success(OrgId), ContextInsightsTestData.BatchJsonWithForbiddenField, Validator, store);

        Assert.Equal(StatusCodes.Status400BadRequest, await StatusCodeOf(result));
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task TraversalContextFile_Returns400_AndStoresNothing()
    {
        var store = new InMemoryContextInsightStore();
        var batch = ContextInsightsTestData.ValidBatch(
            ContextInsightsTestData.ValidRow(contextFile: "../../secrets/admin.instructions.md"));
        var json = JsonSerializer.Serialize(batch, IngestionEndpoints.DisallowOptions);

        var result = await IngestionEndpoints.HandleContextInsightsAsync(
            AuthResult.Success(OrgId), json, Validator, store);

        Assert.Equal(StatusCodes.Status400BadRequest, await StatusCodeOf(result));
        Assert.Equal(0, store.Count);
    }

    [Fact]
    public async Task Unauthenticated_Returns401_AndStoresNothing()
    {
        var store = new InMemoryContextInsightStore();
        var auth = AuthResult.Fail(AuthFailureReason.UnknownKey);

        var result = await IngestionEndpoints.HandleContextInsightsAsync(
            auth, ContextInsightsTestData.ValidBatchJson, Validator, store);

        Assert.Equal(StatusCodes.Status401Unauthorized, await StatusCodeOf(result));
        Assert.Equal(0, store.Count);
    }
}
