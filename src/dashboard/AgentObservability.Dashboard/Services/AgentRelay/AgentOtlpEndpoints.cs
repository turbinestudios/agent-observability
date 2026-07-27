using System.Text;
using System.Text.Json;
using AgentObservability.Dashboard.Models.AgentRelay;
using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services.AgentRelay;

/// <summary>
/// Autonomous-agent OTLP relay API. Same shape as <see cref="IngestionEndpoints"/>: each route is
/// thin (reads its own inputs, checks the feature flag, authenticates) and delegates to a static,
/// host-independent handler core so the auth + store pipeline is unit-testable without a web host.
///
/// The relay is a single authenticated surface with two directions:
/// <list type="bullet">
/// <item><c>POST /agent-otlp/v1/traces</c> — an alert-triggered Copilot CLI agent PUSHES raw OTLP/JSON.</item>
/// <item><c>GET /agent-otlp/batches</c> and <c>GET /agent-otlp/batches/{id}</c> — the VS Code extension PULLS.</item>
/// </list>
/// Every batch is org-scoped by the authenticated key (<see cref="AuthResult.OrgId"/>); a caller can
/// only ever see its own org's batches. Bodies are stored and served VERBATIM — the relay never
/// decodes OTLP (the extension does, with the same decoder the live receiver uses).
/// </summary>
public static class AgentOtlpEndpoints
{
    public static WebApplication MapAgentOtlpApi(this WebApplication app)
    {
        // Producer push. Standard OTLP/HTTP path so a stock OTel exporter can target
        // OTEL_EXPORTER_OTLP_ENDPOINT=<dashboard>/agent-otlp with no custom code.
        app.MapPost("/agent-otlp/v1/traces", async (
            HttpRequest request,
            IngestionAuthenticator authenticator,
            IAgentOtlpBatchStore store,
            IOptions<AgentRelayOptions> options,
            TimeProvider timeProvider,
            CancellationToken cancellationToken) =>
        {
            if (!options.Value.Enabled)
            {
                return ServiceDisabled();
            }

            var auth = await authenticator.AuthenticateAsync(request.Headers.Authorization, cancellationToken)
                .ConfigureAwait(false);

            var body = await ReadBodyAsync(request, cancellationToken).ConfigureAwait(false);
            var nowMs = timeProvider.GetUtcNow().ToUnixTimeMilliseconds();

            return await HandleIngestAsync(auth, body, store, options.Value, nowMs, cancellationToken)
                .ConfigureAwait(false);
        });

        // Extension pull: list batch pointers newer than the watermark.
        app.MapGet("/agent-otlp/batches", async (
            HttpRequest request,
            IngestionAuthenticator authenticator,
            IAgentOtlpBatchStore store,
            IOptions<AgentRelayOptions> options,
            [FromQuery] long? since,
            [FromQuery] int? limit,
            CancellationToken cancellationToken) =>
        {
            if (!options.Value.Enabled)
            {
                return ServiceDisabled();
            }

            var auth = await authenticator.AuthenticateAsync(request.Headers.Authorization, cancellationToken)
                .ConfigureAwait(false);

            return await HandleListAsync(auth, since ?? 0, limit ?? options.Value.MaxListLimit, store, options.Value, cancellationToken)
                .ConfigureAwait(false);
        });

        // Extension pull: fetch one raw batch by id.
        app.MapGet("/agent-otlp/batches/{id}", async (
            HttpRequest request,
            string id,
            IngestionAuthenticator authenticator,
            IAgentOtlpBatchStore store,
            IOptions<AgentRelayOptions> options,
            CancellationToken cancellationToken) =>
        {
            if (!options.Value.Enabled)
            {
                return ServiceDisabled();
            }

            var auth = await authenticator.AuthenticateAsync(request.Headers.Authorization, cancellationToken)
                .ConfigureAwait(false);

            return await HandleDownloadAsync(auth, id, store, cancellationToken).ConfigureAwait(false);
        });

        app.MapGet("/agent-otlp/health", (IOptions<AgentRelayOptions> options) =>
            Results.Ok(new { enabled = options.Value.Enabled }));

        return app;
    }

    /// <summary>
    /// Host-independent core for <c>POST /agent-otlp/v1/traces</c>. Authenticates, guards the body
    /// (non-empty, within the size cap, parseable JSON so the extension can decode it later),
    /// extracts <c>service.name</c> for the listing hint, and stores the body VERBATIM under the
    /// authenticated org. Returns an empty OTLP success response.
    /// </summary>
    public static async Task<IResult> HandleIngestAsync(
        AuthResult auth,
        string body,
        IAgentOtlpBatchStore store,
        AgentRelayOptions options,
        long nowMs,
        CancellationToken cancellationToken = default)
    {
        if (!auth.IsAuthenticated)
        {
            return Unauthorized();
        }

        if (string.IsNullOrWhiteSpace(body))
        {
            return Results.Problem(
                title: "Empty OTLP batch",
                detail: "Request body was empty.",
                statusCode: StatusCodes.Status400BadRequest);
        }

        if (Encoding.UTF8.GetByteCount(body) > options.MaxBatchBytes)
        {
            return Results.Problem(
                title: "OTLP batch too large",
                detail: $"Request body exceeds the {options.MaxBatchBytes}-byte limit.",
                statusCode: StatusCodes.Status413PayloadTooLarge);
        }

        // The extension consumes OTLP/JSON. Reject anything that is not JSON here rather than
        // storing a batch it could never decode. This also yields the service.name listing hint.
        if (!TryExtractServiceName(body, out var service))
        {
            return Results.Problem(
                title: "Invalid OTLP batch",
                detail: "Request body is not valid OTLP/JSON. Configure the exporter with OTEL_EXPORTER_OTLP_PROTOCOL=http/json.",
                statusCode: StatusCodes.Status400BadRequest);
        }

        await store.StoreAsync(auth.OrgId!, service, body, nowMs, cancellationToken).ConfigureAwait(false);

        // Empty ExportTraceServiceResponse — a stock OTLP/HTTP exporter only checks the 2xx status.
        return Results.Text("{}", "application/json", Encoding.UTF8, StatusCodes.Status200OK);
    }

    /// <summary>
    /// Host-independent core for <c>GET /agent-otlp/batches</c>. Returns the org's batches with
    /// <c>createdAtMs &gt;= since</c>, oldest-first, capped to <c>limit</c> (clamped to the
    /// configured maximum), in the <c>{ batches: [...] }</c> envelope the extension expects.
    /// </summary>
    public static async Task<IResult> HandleListAsync(
        AuthResult auth,
        long since,
        int limit,
        IAgentOtlpBatchStore store,
        AgentRelayOptions options,
        CancellationToken cancellationToken = default)
    {
        if (!auth.IsAuthenticated)
        {
            return Unauthorized();
        }

        var clampedLimit = Math.Clamp(limit, 1, Math.Max(1, options.MaxListLimit));
        var sinceMs = Math.Max(0, since);

        var batches = await store.ListAsync(auth.OrgId!, sinceMs, clampedLimit, cancellationToken)
            .ConfigureAwait(false);

        return Results.Ok(new AgentOtlpBatchListResponse { Batches = batches });
    }

    /// <summary>
    /// Host-independent core for <c>GET /agent-otlp/batches/{id}</c>. Returns the raw body verbatim
    /// (<c>application/json</c>), or a uniform 404 for a malformed id or one that does not exist for
    /// the authenticated org.
    /// </summary>
    public static async Task<IResult> HandleDownloadAsync(
        AuthResult auth,
        string id,
        IAgentOtlpBatchStore store,
        CancellationToken cancellationToken = default)
    {
        if (!auth.IsAuthenticated)
        {
            return Unauthorized();
        }

        var body = await store.DownloadAsync(auth.OrgId!, id, cancellationToken).ConfigureAwait(false);
        if (body is null)
        {
            return Results.NotFound();
        }

        return Results.Text(body, "application/json", Encoding.UTF8, StatusCodes.Status200OK);
    }

    /// <summary>503 when the relay is disabled. Exposed for tests.</summary>
    public static IResult ServiceDisabled() => Results.Problem(
        title: "Agent relay disabled",
        detail: "The autonomous-agent OTLP relay is currently disabled.",
        statusCode: StatusCodes.Status503ServiceUnavailable);

    /// <summary>
    /// Best-effort extraction of <c>service.name</c> from an OTLP/JSON trace export. Returns false
    /// only when the body is not valid JSON (the caller maps that to 400); a valid body with no
    /// service.name yields <c>true</c> with <paramref name="service"/> = <c>unknown</c>.
    /// </summary>
    internal static bool TryExtractServiceName(string body, out string service)
    {
        service = "unknown";
        try
        {
            using var doc = JsonDocument.Parse(body);
            if (doc.RootElement.ValueKind != JsonValueKind.Object
                || !doc.RootElement.TryGetProperty("resourceSpans", out var resourceSpans)
                || resourceSpans.ValueKind != JsonValueKind.Array)
            {
                return true; // valid JSON, just no resourceSpans — store it, service stays "unknown".
            }

            foreach (var rs in resourceSpans.EnumerateArray())
            {
                if (rs.ValueKind != JsonValueKind.Object
                    || !rs.TryGetProperty("resource", out var resource)
                    || !resource.TryGetProperty("attributes", out var attributes)
                    || attributes.ValueKind != JsonValueKind.Array)
                {
                    continue;
                }

                foreach (var attr in attributes.EnumerateArray())
                {
                    if (attr.ValueKind == JsonValueKind.Object
                        && attr.TryGetProperty("key", out var key)
                        && key.ValueKind == JsonValueKind.String
                        && key.ValueEquals("service.name")
                        && attr.TryGetProperty("value", out var value)
                        && value.TryGetProperty("stringValue", out var stringValue)
                        && stringValue.ValueKind == JsonValueKind.String)
                    {
                        var name = stringValue.GetString();
                        if (!string.IsNullOrEmpty(name))
                        {
                            service = name;
                            return true;
                        }
                    }
                }
            }

            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }

    /// <summary>
    /// Uniform 401 for every authentication failure, kept indistinguishable to avoid keyId
    /// enumeration. Mirrors <see cref="IngestionEndpoints"/>' Bearer challenge.
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
