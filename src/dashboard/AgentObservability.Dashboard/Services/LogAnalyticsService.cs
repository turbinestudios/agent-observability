using System.Globalization;

using AgentObservability.Dashboard.Models;
using Azure;
using Azure.Identity;
using Azure.Monitor.Query;
using Azure.Monitor.Query.Models;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services;

public sealed class LogAnalyticsOptions
{
    public const string SectionName = "LogAnalytics";

    public string? WorkspaceId { get; init; }
}

public sealed class LogAnalyticsService
{
    private readonly LogsQueryClient? client;
    private readonly ILogger<LogAnalyticsService> logger;
    private readonly string? workspaceId;

    public LogAnalyticsService(IOptions<LogAnalyticsOptions> options, ILogger<LogAnalyticsService> logger)
    {
        this.logger = logger;
        workspaceId = options.Value.WorkspaceId;

        if (!string.IsNullOrWhiteSpace(workspaceId))
        {
            client = new LogsQueryClient(new DefaultAzureCredential());
        }
    }

    public bool IsDemoMode => string.IsNullOrWhiteSpace(workspaceId) || client is null;

    public async Task<DashboardMetrics> GetDashboardMetricsAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        if (IsDemoMode)
        {
            return BuildDemoMetrics();
        }

        const string overviewQuery = """
let RepoBySession = AppDependencies
| where isnotempty(Properties["copilot_chat.repo.remote_url"])
| summarize RepoUrl=take_any(tostring(Properties["copilot_chat.repo.remote_url"])) by SessionId=tostring(Properties["session.id"]);
AppDependencies
| extend SessionId=tostring(Properties["session.id"])
| join kind=leftouter RepoBySession on SessionId
| extend Repository=coalesce(RepoUrl, tostring(Properties["copilot_chat.repo.remote_url"]), "unknown")
| summarize TotalRequests=count(), AverageLatencyMs=avg(DurationMs), P95LatencyMs=percentile(DurationMs, 95), ActiveRepositories=dcount(Repository), ActiveDevelopers=dcount(coalesce(tostring(Properties["enduser.id"]), tostring(UserId)))
""";

        const string volumeQuery = """
AppDependencies
| summarize Requests=count() by Bucket=bin(TimeGenerated, 30m)
| order by Bucket asc
""";

        const string modelQuery = """
AppDependencies
| extend Model=coalesce(tostring(Properties["gen_ai.request.model"]), tostring(Properties["ai.model_id"]), "unknown")
| summarize Requests=count() by Model
| order by Requests desc
""";

        var overview = await QueryAsync(overviewQuery, lookback, cancellationToken);
        var volume = await QueryAsync(volumeQuery, lookback, cancellationToken);
        var modelBreakdown = await QueryAsync(modelQuery, lookback, cancellationToken);

        if (overview is null || overview.Rows.Count == 0)
        {
            return BuildDemoMetrics();
        }

        return new DashboardMetrics
        {
            TotalRequests = GetInt32(overview, 0, "TotalRequests"),
            AverageLatencyMs = GetDouble(overview, 0, "AverageLatencyMs"),
            P95LatencyMs = GetDouble(overview, 0, "P95LatencyMs"),
            ActiveRepositories = GetInt32(overview, 0, "ActiveRepositories"),
            ActiveDevelopers = GetInt32(overview, 0, "ActiveDevelopers"),
            RequestVolume = MapTimeSeries(volume, "Bucket", "Requests", "MM-dd HH:mm"),
            ModelBreakdown = MapNamedValues(modelBreakdown, "Model", "Requests")
        };
    }

    public async Task<IReadOnlyList<NamedValue>> GetModelUsageAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        if (IsDemoMode)
        {
            return BuildDemoModelUsage();
        }

        const string query = """
AppDependencies
| extend Model=coalesce(tostring(Properties["gen_ai.request.model"]), tostring(Properties["ai.model_id"]), "unknown")
| extend InputTokens=todouble(coalesce(Measurements["gen_ai.usage.input_tokens"], Properties["gen_ai.usage.input_tokens"], 0))
| extend OutputTokens=todouble(coalesce(Measurements["gen_ai.usage.output_tokens"], Properties["gen_ai.usage.output_tokens"], 0))
| summarize Requests=count(), InputTokens=sum(InputTokens), OutputTokens=sum(OutputTokens) by Model
| order by Requests desc
""";

        var table = await QueryAsync(query, lookback, cancellationToken);
        return table is null ? BuildDemoModelUsage() : MapNamedValues(table, "Model", "Requests", "InputTokens", "OutputTokens");
    }

    public async Task<IReadOnlyList<DeveloperActivitySummary>> GetDeveloperActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        if (IsDemoMode)
        {
            return BuildDemoDeveloperActivity();
        }

        const string query = """
let RepoBySession = AppDependencies
| where isnotempty(Properties["copilot_chat.repo.remote_url"])
| summarize RepoUrl=take_any(tostring(Properties["copilot_chat.repo.remote_url"])) by SessionId=tostring(Properties["session.id"]);
AppDependencies
| extend SessionId=tostring(Properties["session.id"])
| join kind=leftouter RepoBySession on SessionId
| extend Developer=coalesce(tostring(Properties["enduser.id"]), tostring(UserId), "unknown")
| extend Repository=coalesce(RepoUrl, tostring(Properties["copilot_chat.repo.remote_url"]), "unknown")
| extend Model=coalesce(tostring(Properties["gen_ai.request.model"]), tostring(Properties["ai.model_id"]), "unknown")
| summarize Requests=count(), AverageLatencyMs=avg(DurationMs), UniqueModels=dcount(Model), LastSeen=max(TimeGenerated) by Developer, Repository
| order by Requests desc
""";

        var table = await QueryAsync(query, lookback, cancellationToken);
        return table is null ? BuildDemoDeveloperActivity() : MapDeveloperActivity(table);
    }

    public async Task<IReadOnlyList<RepositoryActivitySummary>> GetRepositoryActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        if (IsDemoMode)
        {
            return BuildDemoRepositoryActivity();
        }

        const string query = """
let RepoBySession = AppDependencies
| where isnotempty(Properties["copilot_chat.repo.remote_url"])
| summarize RepoUrl=take_any(tostring(Properties["copilot_chat.repo.remote_url"])) by SessionId=tostring(Properties["session.id"]);
AppDependencies
| extend SessionId=tostring(Properties["session.id"])
| join kind=leftouter RepoBySession on SessionId
| extend Repository=coalesce(RepoUrl, tostring(Properties["copilot_chat.repo.remote_url"]), "unknown")
| extend Developer=coalesce(tostring(Properties["enduser.id"]), tostring(UserId), "unknown")
| extend Model=coalesce(tostring(Properties["gen_ai.request.model"]), tostring(Properties["ai.model_id"]), "unknown")
| summarize Requests=count(), ActiveDevelopers=dcount(Developer), AverageLatencyMs=avg(DurationMs), UniqueModels=dcount(Model) by Repository
| order by Requests desc
""";

        var table = await QueryAsync(query, lookback, cancellationToken);
        return table is null ? BuildDemoRepositoryActivity() : MapRepositoryActivity(table);
    }

    public async Task<IReadOnlyList<AgentInteraction>> GetWorkflowInteractionsAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        if (IsDemoMode)
        {
            return BuildDemoWorkflowInteractions();
        }

        const string query = """
let RepoBySession = AppDependencies
| where isnotempty(Properties["copilot_chat.repo.remote_url"])
| summarize RepoUrl=take_any(tostring(Properties["copilot_chat.repo.remote_url"])) by SessionId=tostring(Properties["session.id"]);
AppDependencies
| extend SessionId=tostring(Properties["session.id"])
| join kind=leftouter RepoBySession on SessionId
| extend Repository=coalesce(RepoUrl, tostring(Properties["copilot_chat.repo.remote_url"]), "unknown")
| extend Agent=coalesce(tostring(Properties["github.copilot.agent"]), tostring(Properties["gen_ai.agent.name"]), "copilot")
| extend ToolName=coalesce(tostring(Properties["tool.name"]), tostring(Name), "unknown")
| extend Model=coalesce(tostring(Properties["gen_ai.request.model"]), tostring(Properties["ai.model_id"]), "unknown")
| project TimeGenerated, Repository, Agent, ToolName, Model, DurationMs, Success
| top 50 by TimeGenerated desc
""";

        var table = await QueryAsync(query, lookback, cancellationToken);
        return table is null ? BuildDemoWorkflowInteractions() : MapWorkflowInteractions(table);
    }

    private async Task<LogsTable?> QueryAsync(string query, TimeSpan lookback, CancellationToken cancellationToken)
    {
        if (client is null || string.IsNullOrWhiteSpace(workspaceId))
        {
            return null;
        }

        try
        {
            var response = await client.QueryWorkspaceAsync(
                workspaceId,
                query,
                new QueryTimeRange(lookback),
                cancellationToken: cancellationToken);

            return response.Value.Table;
        }
        catch (RequestFailedException exception)
        {
            logger.LogWarning(exception, "Log Analytics query failed for workspace {WorkspaceId}", workspaceId);
            return null;
        }
        catch (Exception exception)
        {
            logger.LogError(exception, "Unexpected Log Analytics failure for workspace {WorkspaceId}", workspaceId);
            return null;
        }
    }

    private static IReadOnlyList<TimeSeriesPoint> MapTimeSeries(LogsTable? table, string timestampColumn, string valueColumn, string labelFormat)
    {
        if (table is null || table.Rows.Count == 0)
        {
            return [];
        }

        var points = new List<TimeSeriesPoint>(table.Rows.Count);

        for (var index = 0; index < table.Rows.Count; index++)
        {
            var timestamp = GetDateTimeOffset(table, index, timestampColumn);
            points.Add(new TimeSeriesPoint
            {
                Timestamp = timestamp,
                Label = timestamp.ToLocalTime().ToString(labelFormat, CultureInfo.InvariantCulture),
                Value = GetDouble(table, index, valueColumn)
            });
        }

        return points;
    }

    private static IReadOnlyList<NamedValue> MapNamedValues(LogsTable? table, string labelColumn, string valueColumn, string? secondaryValueColumn = null, string? tertiaryValueColumn = null)
    {
        if (table is null || table.Rows.Count == 0)
        {
            return [];
        }

        var items = new List<NamedValue>(table.Rows.Count);

        for (var index = 0; index < table.Rows.Count; index++)
        {
            var secondaryValue = 0d;

            if (!string.IsNullOrWhiteSpace(secondaryValueColumn))
            {
                secondaryValue += GetDouble(table, index, secondaryValueColumn);
            }

            if (!string.IsNullOrWhiteSpace(tertiaryValueColumn))
            {
                secondaryValue += GetDouble(table, index, tertiaryValueColumn);
            }

            items.Add(new NamedValue
            {
                Label = GetString(table, index, labelColumn),
                Value = GetDouble(table, index, valueColumn),
                SecondaryValue = secondaryValue
            });
        }

        return items;
    }

    private static IReadOnlyList<DeveloperActivitySummary> MapDeveloperActivity(LogsTable table)
    {
        var items = new List<DeveloperActivitySummary>(table.Rows.Count);

        for (var index = 0; index < table.Rows.Count; index++)
        {
            items.Add(new DeveloperActivitySummary
            {
                Developer = GetString(table, index, "Developer"),
                Repository = GetString(table, index, "Repository"),
                Requests = GetInt32(table, index, "Requests"),
                AverageLatencyMs = GetDouble(table, index, "AverageLatencyMs"),
                UniqueModels = GetInt32(table, index, "UniqueModels"),
                LastSeen = GetDateTimeOffset(table, index, "LastSeen")
            });
        }

        return items;
    }

    private static IReadOnlyList<RepositoryActivitySummary> MapRepositoryActivity(LogsTable table)
    {
        var items = new List<RepositoryActivitySummary>(table.Rows.Count);

        for (var index = 0; index < table.Rows.Count; index++)
        {
            items.Add(new RepositoryActivitySummary
            {
                Repository = GetString(table, index, "Repository"),
                Requests = GetInt32(table, index, "Requests"),
                ActiveDevelopers = GetInt32(table, index, "ActiveDevelopers"),
                AverageLatencyMs = GetDouble(table, index, "AverageLatencyMs"),
                UniqueModels = GetInt32(table, index, "UniqueModels")
            });
        }

        return items;
    }

    private static IReadOnlyList<AgentInteraction> MapWorkflowInteractions(LogsTable table)
    {
        var items = new List<AgentInteraction>(table.Rows.Count);

        for (var index = 0; index < table.Rows.Count; index++)
        {
            items.Add(new AgentInteraction
            {
                Timestamp = GetDateTimeOffset(table, index, "TimeGenerated"),
                Repository = GetString(table, index, "Repository"),
                Agent = GetString(table, index, "Agent"),
                ToolName = GetString(table, index, "ToolName"),
                Model = GetString(table, index, "Model"),
                DurationMs = GetDouble(table, index, "DurationMs"),
                Success = GetBoolean(table, index, "Success")
            });
        }

        return items;
    }

    private static int GetColumnIndex(LogsTable table, string columnName)
    {
        for (var index = 0; index < table.Columns.Count; index++)
        {
            if (string.Equals(table.Columns[index].Name, columnName, StringComparison.OrdinalIgnoreCase))
            {
                return index;
            }
        }

        return -1;
    }

    private static object? GetValue(LogsTable table, int rowIndex, string columnName)
    {
        var columnIndex = GetColumnIndex(table, columnName);
        return columnIndex < 0 ? null : table.Rows[rowIndex][columnIndex];
    }

    private static string GetString(LogsTable table, int rowIndex, string columnName)
    {
        return Convert.ToString(GetValue(table, rowIndex, columnName), CultureInfo.InvariantCulture) ?? string.Empty;
    }

    private static int GetInt32(LogsTable table, int rowIndex, string columnName)
    {
        return Convert.ToInt32(GetValue(table, rowIndex, columnName) ?? 0, CultureInfo.InvariantCulture);
    }

    private static double GetDouble(LogsTable table, int rowIndex, string columnName)
    {
        return Convert.ToDouble(GetValue(table, rowIndex, columnName) ?? 0d, CultureInfo.InvariantCulture);
    }

    private static bool GetBoolean(LogsTable table, int rowIndex, string columnName)
    {
        return Convert.ToBoolean(GetValue(table, rowIndex, columnName) ?? false, CultureInfo.InvariantCulture);
    }

    private static DateTimeOffset GetDateTimeOffset(LogsTable table, int rowIndex, string columnName)
    {
        var value = GetValue(table, rowIndex, columnName);

        return value switch
        {
            DateTimeOffset timestamp => timestamp,
            DateTime timestamp => new DateTimeOffset(DateTime.SpecifyKind(timestamp, DateTimeKind.Utc)),
            _ => DateTimeOffset.UtcNow
        };
    }

    private static DashboardMetrics BuildDemoMetrics()
    {
        return new DashboardMetrics
        {
            TotalRequests = 1284,
            AverageLatencyMs = 692,
            P95LatencyMs = 1840,
            ActiveRepositories = 5,
            ActiveDevelopers = 11,
            RequestVolume = BuildDemoRequestVolume(),
            ModelBreakdown =
            [
                new NamedValue { Label = "gpt-5.4", Value = 714 },
                new NamedValue { Label = "claude-sonnet-4.5", Value = 328 },
                new NamedValue { Label = "gpt-4.1", Value = 242 }
            ]
        };
    }

    private static IReadOnlyList<NamedValue> BuildDemoModelUsage()
    {
        return
        [
            new NamedValue { Label = "gpt-5.4", Value = 714, SecondaryValue = 211000 },
            new NamedValue { Label = "claude-sonnet-4.5", Value = 328, SecondaryValue = 128400 },
            new NamedValue { Label = "gpt-4.1", Value = 242, SecondaryValue = 76420 }
        ];
    }

    private static IReadOnlyList<DeveloperActivitySummary> BuildDemoDeveloperActivity()
    {
        return
        [
            new DeveloperActivitySummary
            {
                Developer = "jane.doe",
                Repository = "agent-observability",
                Requests = 214,
                AverageLatencyMs = 618,
                UniqueModels = 3,
                LastSeen = DateTimeOffset.UtcNow.AddMinutes(-12)
            },
            new DeveloperActivitySummary
            {
                Developer = "sara.lind",
                Repository = "payment-service",
                Requests = 188,
                AverageLatencyMs = 701,
                UniqueModels = 2,
                LastSeen = DateTimeOffset.UtcNow.AddMinutes(-26)
            },
            new DeveloperActivitySummary
            {
                Developer = "joel.berg",
                Repository = "customer-portal",
                Requests = 163,
                AverageLatencyMs = 749,
                UniqueModels = 2,
                LastSeen = DateTimeOffset.UtcNow.AddMinutes(-44)
            }
        ];
    }

    private static IReadOnlyList<RepositoryActivitySummary> BuildDemoRepositoryActivity()
    {
        return
        [
            new RepositoryActivitySummary
            {
                Repository = "agent-observability",
                Requests = 412,
                ActiveDevelopers = 4,
                AverageLatencyMs = 632,
                UniqueModels = 3
            },
            new RepositoryActivitySummary
            {
                Repository = "payment-service",
                Requests = 351,
                ActiveDevelopers = 3,
                AverageLatencyMs = 718,
                UniqueModels = 2
            },
            new RepositoryActivitySummary
            {
                Repository = "customer-portal",
                Requests = 287,
                ActiveDevelopers = 2,
                AverageLatencyMs = 764,
                UniqueModels = 2
            }
        ];
    }

    private static IReadOnlyList<AgentInteraction> BuildDemoWorkflowInteractions()
    {
        return
        [
            new AgentInteraction
            {
                Timestamp = DateTimeOffset.UtcNow.AddMinutes(-8),
                Repository = "agent-observability",
                Agent = "planner",
                ToolName = "semantic_search",
                Model = "gpt-5.4",
                DurationMs = 241,
                Success = true
            },
            new AgentInteraction
            {
                Timestamp = DateTimeOffset.UtcNow.AddMinutes(-6),
                Repository = "agent-observability",
                Agent = "coder",
                ToolName = "apply_patch",
                Model = "gpt-5.4",
                DurationMs = 514,
                Success = true
            },
            new AgentInteraction
            {
                Timestamp = DateTimeOffset.UtcNow.AddMinutes(-4),
                Repository = "agent-observability",
                Agent = "reviewer",
                ToolName = "execution_subagent",
                Model = "claude-sonnet-4.5",
                DurationMs = 667,
                Success = true
            }
        ];
    }

    private static IReadOnlyList<TimeSeriesPoint> BuildDemoRequestVolume()
    {
        var baseline = DateTimeOffset.UtcNow.AddHours(-8);
        var values = new[] { 24d, 28d, 36d, 42d, 58d, 64d, 72d, 68d, 76d, 81d, 74d, 66d, 54d, 49d, 38d, 31d };
        var points = new List<TimeSeriesPoint>(values.Length);

        for (var index = 0; index < values.Length; index++)
        {
            var timestamp = baseline.AddMinutes(index * 30);
            points.Add(new TimeSeriesPoint
            {
                Timestamp = timestamp,
                Label = timestamp.ToLocalTime().ToString("HH:mm", CultureInfo.InvariantCulture),
                Value = values[index]
            });
        }

        return points;
    }
}