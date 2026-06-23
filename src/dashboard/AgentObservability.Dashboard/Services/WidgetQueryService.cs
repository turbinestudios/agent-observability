using System.Text.RegularExpressions;
using AgentObservability.Dashboard.Models;
using Azure.Identity;
using Azure.Monitor.Query;
using Azure.Monitor.Query.Models;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services;

public sealed partial class WidgetQueryService
{
    private readonly LogsQueryClient _client;
    private readonly string _workspaceId;
    private readonly ILogger<WidgetQueryService> _logger;
    private readonly bool _exposeRawSessionDetail;

    public WidgetQueryService(
        IOptions<LogAnalyticsOptions> options,
        IOptions<WebUxOptions> webUxOptions,
        ILogger<WidgetQueryService> logger)
    {
        _logger = logger;
        _workspaceId = options.Value.WorkspaceId
            ?? throw new InvalidOperationException("LogAnalytics:WorkspaceId must be configured.");
        _exposeRawSessionDetail = webUxOptions.Value.ExposeRawSessionDetail;
        _client = new LogsQueryClient(new DefaultAzureCredential());
    }

    public async Task<WidgetQueryResult> ExecuteWidgetQueryAsync(
        string kqlQuery,
        List<DashboardFilter> filters,
        TimeSpan lookback,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(kqlQuery))
        {
            return new WidgetQueryResult { Error = "No query specified." };
        }

        // Phase 10 guardrail: reject any query that references raw telemetry tables, raw-content
        // fields, or the raw property/measurement bags BEFORE touching Log Analytics. This enforces
        // the aggregate-only contract at execution time, not just via the AI prompt.
        //
        // WebUxOptions.ExposeRawSessionDetail is the single master switch for the raw-vs-aggregate
        // world: default false = aggregate-only, so the guardrail is enforced and every executed
        // query is checked. When true (one-release rollback) raw queries are allowed and the
        // guardrail is bypassed so Workflows / raw widgets keep working with prior behavior.
        var guardrailError = GetGuardrailError(kqlQuery, _exposeRawSessionDetail);
        if (guardrailError is not null)
        {
            _logger.LogWarning("Blocked widget query referencing forbidden raw telemetry: {Reason}", guardrailError);
            return new WidgetQueryResult { Error = guardrailError };
        }

        try
        {
            // Build filter preamble using 'let' statements for safe parameter injection
            var fullQuery = BuildQueryWithFilters(kqlQuery, filters);

            var response = await _client.QueryWorkspaceAsync(
                _workspaceId,
                fullQuery,
                new QueryTimeRange(lookback),
                cancellationToken: cancellationToken);

            var table = response.Value.Table;
            var result = new WidgetQueryResult
            {
                Columns = table.Columns.Select(c => c.Name).ToList()
            };

            foreach (var row in table.Rows)
            {
                var dict = new Dictionary<string, object?>();
                for (int i = 0; i < table.Columns.Count; i++)
                {
                    dict[table.Columns[i].Name] = row[i];
                }
                result.Rows.Add(dict);
            }

            return result;
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to execute widget query");
            return new WidgetQueryResult { Error = ex.Message };
        }
    }

    /// <summary>
    /// Forbidden raw telemetry table names. Matched case-insensitively on whole-word boundaries so
    /// casing variants (e.g. <c>appdependencies</c>) cannot evade the check.
    /// </summary>
    private static readonly string[] ForbiddenTables =
    [
        "AppDependencies",
        "AppTraces",
        "AppRequests",
        "traces",
        "dependencies",
    ];

    /// <summary>
    /// Forbidden raw property-bag accessors. Reading raw prompt/tool/reasoning content out of the
    /// retired telemetry is only possible by indexing the dynamic <c>Properties[...]</c> /
    /// <c>Measurements[...]</c> bags, so blocking these accessors (case-insensitive) closes the
    /// practical evasion path even for field names not in <see cref="ForbiddenRawContentFields"/>.
    /// Matched as literal substrings because the bracket makes them unambiguous.
    /// </summary>
    private static readonly string[] ForbiddenRawAccessors =
    [
        "Properties[",
        "Measurements[",
    ];

    /// <summary>
    /// Forbidden raw-content fields. These may contain dots/underscores so they are matched as
    /// boundary-delimited literal phrases (case-insensitive).
    /// </summary>
    private static readonly string[] ForbiddenRawContentFields =
    [
        "user_request",
        "gen_ai.input.messages",
        "gen_ai.output.messages",
        "system_instructions",
        "tool.call.arguments",
        "tool.call.result",
        "reasoning_content",
        "hook_",
    ];

    /// <summary>
    /// Pure guardrail check. Returns <c>null</c> when the query is allowed (aggregate-only), or an
    /// error message describing the first forbidden reference found. Rejects any reference to raw
    /// telemetry tables (AppDependencies, AppTraces, AppRequests, traces, dependencies), the raw
    /// property/measurement bag accessors (Properties[, Measurements[), or raw-content fields
    /// (user_request, gen_ai.input/output.messages, system_instructions, tool.call.arguments/result,
    /// reasoning_content, hook_*). Matching is case-insensitive and boundary-aware so it cannot be
    /// evaded by casing.
    /// </summary>
    /// <summary>
    /// The flag-gated guardrail decision (the seam invoked by <see cref="ExecuteWidgetQueryAsync"/>).
    /// In aggregate-only mode (<paramref name="exposeRawSessionDetail"/> == false, the default) it
    /// returns <see cref="ValidateQueryAllowed"/>'s verdict so raw queries are rejected before any
    /// Log Analytics access. In rollback mode (true) the guardrail is bypassed (returns null) so the
    /// raw Workflows/widget paths keep working for one release.
    /// </summary>
    internal static string? GetGuardrailError(string kql, bool exposeRawSessionDetail)
    {
        return exposeRawSessionDetail ? null : ValidateQueryAllowed(kql);
    }

    public static string? ValidateQueryAllowed(string kql)
    {
        if (string.IsNullOrWhiteSpace(kql))
            return null;

        foreach (var accessor in ForbiddenRawAccessors)
        {
            // Indexing the dynamic property/measurement bags is the only way to read raw content;
            // a literal case-insensitive match on the accessor token closes that evasion path.
            if (kql.Contains(accessor, StringComparison.OrdinalIgnoreCase))
            {
                return $"This query uses the raw '{accessor}...]' property bag, which is not exposed by the aggregate store. Reference aggregate columns directly (e.g. repository, developerId, interactionCount); raw prompt/tool/reasoning content is only available locally in the VS Code extension.";
            }
        }

        foreach (var table in ForbiddenTables)
        {
            // \b word boundaries handle identifiers; Regex.Escape keeps it literal.
            var pattern = $@"\b{Regex.Escape(table)}\b";
            if (Regex.IsMatch(kql, pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                return $"This query references the raw telemetry table '{table}', which is no longer available. Use aggregate fields only (e.g. interactionCount, inputTokens, durationMsSum) over the aggregate store.";
            }
        }

        foreach (var field in ForbiddenRawContentFields)
        {
            // Dots/underscores in these field names are matched literally. A boundary on the left
            // and a non-(word|dot) boundary on the right prevents partial-token false negatives
            // while still catching the field wherever it appears (in brackets, quotes, etc.).
            var pattern = $@"(?<![A-Za-z0-9_]){Regex.Escape(field)}";
            if (Regex.IsMatch(kql, pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))
            {
                return $"This query references the raw-content field '{field}', which is not exposed by the aggregate store. Raw prompt/tool/reasoning content is only available locally in the VS Code extension.";
            }
        }

        return null;
    }

    private static string BuildQueryWithFilters(string kqlQuery, List<DashboardFilter> filters)
    {
        if (filters.Count == 0)
            return kqlQuery;

        var preamble = new List<string>();

        foreach (var filter in filters)
        {
            switch (filter.FilterType)
            {
                case DashboardFilterType.Repository when filter.Values.Count > 0:
                    var repoValues = string.Join(", ", filter.Values.Select(v => $"\"{EscapeKqlString(v)}\""));
                    preamble.Add($"let _filter_repositories = dynamic([{repoValues}]);");
                    break;

                case DashboardFilterType.Developer when filter.Values.Count > 0:
                    var devValues = string.Join(", ", filter.Values.Select(v => $"\"{EscapeKqlString(v)}\""));
                    preamble.Add($"let _filter_developers = dynamic([{devValues}]);");
                    break;

                case DashboardFilterType.TimeRange when filter.Values.Count > 0:
                    preamble.Add($"let _filter_timerange = \"{EscapeKqlString(filter.Values[0])}\";");
                    break;

                case DashboardFilterType.Custom when !string.IsNullOrEmpty(filter.Key) && filter.Values.Count > 0:
                    var sanitizedKey = SanitizeIdentifier(filter.Key);
                    var customValues = string.Join(", ", filter.Values.Select(v => $"\"{EscapeKqlString(v)}\""));
                    preamble.Add($"let _filter_{sanitizedKey} = dynamic([{customValues}]);");
                    break;
            }
        }

        if (preamble.Count == 0)
            return kqlQuery;

        return string.Join("\n", preamble) + "\n" + kqlQuery;
    }

    private static string EscapeKqlString(string value)
    {
        return value.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }

    private static string SanitizeIdentifier(string key)
    {
        return IdentifierRegex().Replace(key, "_").ToLowerInvariant();
    }

    [GeneratedRegex("[^a-zA-Z0-9_]")]
    private static partial Regex IdentifierRegex();
}
