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

    public WidgetQueryService(IOptions<LogAnalyticsOptions> options, ILogger<WidgetQueryService> logger)
    {
        _logger = logger;
        _workspaceId = options.Value.WorkspaceId
            ?? throw new InvalidOperationException("LogAnalytics:WorkspaceId must be configured.");
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
