using System.Text.Json;
using System.Text.Json.Serialization;
using AgentObservability.Dashboard.Models.Ingestion;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Cloud ingestion API. Endpoints are thin: each route reads the raw body itself and delegates to a
/// static, host-independent handler core (deps passed as params) so the auth + validate + store
/// pipeline is unit-testable without a web host.
/// </summary>
public static class IngestionEndpoints
{
    /// <summary>
    /// JSON options used for deserializing inbound batches. <see cref="JsonUnmappedMemberHandling.Disallow"/>
    /// is set on the DTOs themselves; these options additionally ignore casing leniency so we control
    /// rejection of unknown fields explicitly rather than relying on default model binding.
    /// </summary>
    public static readonly JsonSerializerOptions DisallowOptions = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        PropertyNameCaseInsensitive = false,
    };

    public static WebApplication MapIngestionApi(this WebApplication app)
    {
        app.MapPost("/api/ingest/aggregate", async (
            HttpRequest request,
            IngestionAuthenticator authenticator,
            AggregateBatchValidator validator,
            IAggregateStore store,
            IOptions<IngestionOptions> options,
            CancellationToken cancellationToken) =>
        {
            if (!options.Value.Enabled)
            {
                return ServiceDisabled();
            }

            var auth = await authenticator.AuthenticateAsync(request.Headers.Authorization, cancellationToken)
                .ConfigureAwait(false);

            var body = await ReadBodyAsync(request, cancellationToken).ConfigureAwait(false);

            return await HandleAggregateAsync(auth, body, validator, store, cancellationToken).ConfigureAwait(false);
        });

        app.MapPost("/api/ingest/context-insights", async (
            HttpRequest request,
            IngestionAuthenticator authenticator,
            ContextInsightsBatchValidator validator,
            IContextInsightStore store,
            IOptions<IngestionOptions> options,
            CancellationToken cancellationToken) =>
        {
            if (!options.Value.Enabled)
            {
                return ServiceDisabled();
            }

            var auth = await authenticator.AuthenticateAsync(request.Headers.Authorization, cancellationToken)
                .ConfigureAwait(false);

            var body = await ReadBodyAsync(request, cancellationToken).ConfigureAwait(false);

            return await HandleContextInsightsAsync(auth, body, validator, store, cancellationToken).ConfigureAwait(false);
        });

        app.MapPost("/api/ingest/status", async (
            HttpRequest request,
            IngestionAuthenticator authenticator,
            ISyncStatusStore store,
            IOptions<IngestionOptions> options,
            CancellationToken cancellationToken) =>
        {
            if (!options.Value.Enabled)
            {
                return ServiceDisabled();
            }

            var auth = await authenticator.AuthenticateAsync(request.Headers.Authorization, cancellationToken)
                .ConfigureAwait(false);

            var body = await ReadBodyAsync(request, cancellationToken).ConfigureAwait(false);

            return await HandleStatusAsync(auth, body, store, cancellationToken).ConfigureAwait(false);
        });

        app.MapGet("/api/ingest/health", (IOptions<IngestionOptions> options) =>
            Results.Ok(new { enabled = options.Value.Enabled }));

        return app;
    }

    /// <summary>
    /// Host-independent core for <c>POST /api/ingest/aggregate</c>. Given an already-computed
    /// <see cref="AuthResult"/> and the raw request body, returns the <see cref="IResult"/> to send.
    /// Directly callable in tests.
    /// </summary>
    public static async Task<IResult> HandleAggregateAsync(
        AuthResult auth,
        string body,
        AggregateBatchValidator validator,
        IAggregateStore store,
        CancellationToken cancellationToken = default)
    {
        if (!auth.IsAuthenticated)
        {
            return Unauthorized();
        }

        AggregateBatch? batch;
        try
        {
            batch = JsonSerializer.Deserialize<AggregateBatch>(body, DisallowOptions);
        }
        catch (JsonException ex)
        {
            // Unknown/unexpected field (additionalProperties:false) or otherwise malformed JSON.
            return Results.Problem(
                title: "Invalid aggregate batch",
                detail: $"Request body could not be parsed (possible unexpected field): {ex.Message}",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (batch is null)
        {
            return Results.Problem(
                title: "Invalid aggregate batch",
                detail: "Request body was empty or null.",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var errors = validator.Validate(batch);
        if (errors.Count > 0)
        {
            return Results.ValidationProblem(
                new Dictionary<string, string[]> { ["batch"] = errors.ToArray() },
                title: "Aggregate batch failed validation",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // orgId is from the validated key record, NEVER from the payload.
        await store.UpsertBucketsAsync(auth.OrgId!, batch, cancellationToken).ConfigureAwait(false);

        return Results.Ok(new { accepted = batch.Buckets.Count, batchId = batch.BatchId });
    }

    /// <summary>
    /// Host-independent core for <c>POST /api/ingest/context-insights</c>. Mirrors
    /// <see cref="HandleAggregateAsync"/>: authenticate, strictly deserialize (unknown fields are
    /// rejected), re-validate the privacy rules server-side, then upsert by the validated org
    /// (never the payload). Directly callable in tests.
    /// </summary>
    public static async Task<IResult> HandleContextInsightsAsync(
        AuthResult auth,
        string body,
        ContextInsightsBatchValidator validator,
        IContextInsightStore store,
        CancellationToken cancellationToken = default)
    {
        if (!auth.IsAuthenticated)
        {
            return Unauthorized();
        }

        ContextInsightsBatch? batch;
        try
        {
            batch = JsonSerializer.Deserialize<ContextInsightsBatch>(body, DisallowOptions);
        }
        catch (JsonException ex)
        {
            // Unknown/unexpected field (additionalProperties:false) or otherwise malformed JSON.
            return Results.Problem(
                title: "Invalid context-insights batch",
                detail: $"Request body could not be parsed (possible unexpected field): {ex.Message}",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (batch is null)
        {
            return Results.Problem(
                title: "Invalid context-insights batch",
                detail: "Request body was empty or null.",
                statusCode: StatusCodes.Status400BadRequest);
        }

        var errors = validator.Validate(batch);
        if (errors.Count > 0)
        {
            return Results.ValidationProblem(
                new Dictionary<string, string[]> { ["batch"] = errors.ToArray() },
                title: "Context-insights batch failed validation",
                statusCode: StatusCodes.Status400BadRequest);
        }

        // orgId is from the validated key record, NEVER from the payload.
        await store.UpsertRowsAsync(auth.OrgId!, batch, cancellationToken).ConfigureAwait(false);

        return Results.Ok(new { accepted = batch.Rows.Count, batchId = batch.BatchId });
    }

    /// <summary>Host-independent core for <c>POST /api/ingest/status</c>.</summary>
    public static async Task<IResult> HandleStatusAsync(
        AuthResult auth,
        string body,
        ISyncStatusStore store,
        CancellationToken cancellationToken = default)
    {
        if (!auth.IsAuthenticated)
        {
            return Unauthorized();
        }

        SyncStatusReport? report;
        try
        {
            report = JsonSerializer.Deserialize<SyncStatusReport>(body, DisallowOptions);
        }
        catch (JsonException ex)
        {
            return Results.Problem(
                title: "Invalid sync status",
                detail: $"Request body could not be parsed (possible unexpected field): {ex.Message}",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (report is null || string.IsNullOrEmpty(report.PseudonymousDeveloperId))
        {
            return Results.Problem(
                title: "Invalid sync status",
                detail: "Request body was empty or missing pseudonymousDeveloperId.",
                statusCode: StatusCodes.Status400BadRequest);
        }

        await store.SaveAsync(auth.OrgId!, report, cancellationToken).ConfigureAwait(false);

        return Results.Ok(new { stored = true });
    }

    /// <summary>503 when ingestion is disabled. Exposed for tests.</summary>
    public static IResult ServiceDisabled() => Results.Problem(
        title: "Ingestion disabled",
        detail: "The ingestion API is currently disabled.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    /// <summary>
    /// Uniform 401 for every authentication failure (missing/malformed/unknown/invalid/disabled),
    /// kept indistinguishable to avoid keyId enumeration. Adds the standard Bearer challenge.
    /// </summary>
    private static IResult Unauthorized() => new BearerUnauthorizedResult();

    private static async Task<string> ReadBodyAsync(HttpRequest request, CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(request.Body);
        return await reader.ReadToEndAsync(cancellationToken).ConfigureAwait(false);
    }

    /// <summary>401 with a <c>WWW-Authenticate: Bearer</c> challenge and a minimal machine-readable body.</summary>
    private sealed class BearerUnauthorizedResult : IResult
    {
        public async Task ExecuteAsync(HttpContext httpContext)
        {
            httpContext.Response.StatusCode = StatusCodes.Status401Unauthorized;
            httpContext.Response.Headers.WWWAuthenticate = "Bearer error=\"invalid_token\"";
            await httpContext.Response.WriteAsJsonAsync(new { error = "invalid_token" });
        }
    }
}
