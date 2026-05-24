using AgentObservability.Dashboard.Models;
using Azure.AI.Projects;
using Azure.Identity;
using Microsoft.Extensions.Options;
using OpenAI.Chat;
using System.ClientModel;

namespace AgentObservability.Dashboard.Services;

public sealed class AzureAIOptions
{
    public const string SectionName = "AzureAI";

    public string Endpoint { get; init; } = string.Empty;
    public string DeploymentName { get; init; } = "gpt-4o";
}

public sealed class KqlGenerationResult
{
    public string KqlQuery { get; init; } = string.Empty;
    public string Explanation { get; init; } = string.Empty;
}

public sealed class LearningProposal
{
    public string Title { get; init; } = string.Empty;
    public string RuleText { get; init; } = string.Empty;
    public string? KqlExample { get; init; }
}

public sealed class TeachingResult
{
    public string Response { get; init; } = string.Empty;
    public LearningProposal? Proposal { get; init; }
}

public sealed class KqlGenerationService
{
    private readonly AIProjectClient _projectClient;
    private readonly string _deploymentName;
    private readonly LearningService _learningService;
    private readonly ILogger<KqlGenerationService> _logger;

    public KqlGenerationService(IOptions<AzureAIOptions> options, LearningService learningService, ILogger<KqlGenerationService> logger)
    {
        _logger = logger;
        _learningService = learningService;
        var endpoint = options.Value.Endpoint;
        if (string.IsNullOrEmpty(endpoint))
        {
            throw new InvalidOperationException("AzureAI:Endpoint must be configured.");
        }

        _deploymentName = options.Value.DeploymentName;
        _projectClient = new AIProjectClient(new Uri(endpoint), new DefaultAzureCredential());
    }

    public async Task<KqlGenerationResult> GenerateKqlAsync(
        string userPrompt,
        List<DashboardFilter> filters,
        WidgetType widgetType,
        string? existingKql = null,
        CancellationToken cancellationToken = default)
    {
        return await GenerateKqlAsync(userPrompt, filters, widgetType, existingKql, [], cancellationToken);
    }

    public async Task<KqlGenerationResult> GenerateKqlAsync(
        string userPrompt,
        List<DashboardFilter> filters,
        WidgetType widgetType,
        string? existingKql,
        IReadOnlyList<(string Role, string Content)> conversationHistory,
        CancellationToken cancellationToken = default)
    {
        var systemMessage = BuildSystemPrompt(filters, widgetType);
        var learningsContext = await BuildLearningsContextAsync(cancellationToken);
        if (!string.IsNullOrEmpty(learningsContext))
        {
            systemMessage += "\n\n" + learningsContext;
        }

        var userMessage = BuildUserMessage(userPrompt, existingKql);

        try
        {
            var chatClient = _projectClient.ProjectOpenAIClient.GetChatClient(_deploymentName);

            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemMessage)
            };

            foreach (var (role, content) in conversationHistory)
            {
                if (string.Equals(role, "user", StringComparison.OrdinalIgnoreCase))
                    messages.Add(new UserChatMessage(content));
                else
                    messages.Add(new AssistantChatMessage(content));
            }

            messages.Add(new UserChatMessage(userMessage));

            var options = new ChatCompletionOptions
            {
                Temperature = 0.2f
            };

            ChatCompletion completion = await chatClient.CompleteChatAsync(messages, options, cancellationToken);
            var content2 = completion.Content[0].Text;

            return ParseResponse(content2);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to generate KQL query from AI");
            return new KqlGenerationResult
            {
                KqlQuery = existingKql ?? string.Empty,
                Explanation = $"Error: {ex.Message}"
            };
        }
    }

    public async Task<TeachingResult> GenerateTeachingResponseAsync(
        string userMessage,
        IReadOnlyList<(string Role, string Content)> conversationHistory,
        CancellationToken cancellationToken = default)
    {
        var systemPrompt = BuildTeachingSystemPrompt();

        try
        {
            var chatClient = _projectClient.ProjectOpenAIClient.GetChatClient(_deploymentName);

            var messages = new List<ChatMessage>
            {
                new SystemChatMessage(systemPrompt)
            };

            foreach (var (role, content) in conversationHistory)
            {
                if (string.Equals(role, "user", StringComparison.OrdinalIgnoreCase))
                    messages.Add(new UserChatMessage(content));
                else
                    messages.Add(new AssistantChatMessage(content));
            }

            messages.Add(new UserChatMessage(userMessage));

            var options = new ChatCompletionOptions
            {
                Temperature = 0.3f
            };

            ChatCompletion completion = await chatClient.CompleteChatAsync(messages, options, cancellationToken);
            var responseText = completion.Content[0].Text;

            return ParseTeachingResponse(responseText);
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to generate teaching response from AI");
            return new TeachingResult
            {
                Response = $"Error: {ex.Message}"
            };
        }
    }

    private async Task<string> BuildLearningsContextAsync(CancellationToken cancellationToken)
    {
        var learnings = await _learningService.GetAllLearningsAsync(cancellationToken);
        if (learnings.Count == 0) return string.Empty;

        var lines = new List<string>
        {
            "## Learned Rules",
            "The following rules have been taught by users. Always apply them when relevant:"
        };

        for (int i = 0; i < learnings.Count; i++)
        {
            var learning = learnings[i];
            lines.Add($"\n### Rule {i + 1}: {learning.Title}");
            lines.Add(learning.RuleText);
            if (!string.IsNullOrEmpty(learning.KqlExample))
            {
                lines.Add($"```kql\n{learning.KqlExample}\n```");
            }
        }

        return string.Join("\n", lines);
    }

    private static string BuildTeachingSystemPrompt()
    {
        return """
            You are a helpful assistant that collaborates with users to create reusable knowledge rules for a KQL query assistant.

            The user wants to teach you something about their environment, query patterns, or conventions. Your job is to:
            1. Listen to what the user wants to teach you
            2. Ask clarifying questions if needed to make the rule precise and actionable
            3. When you have enough information, propose a structured learning with a clear title, rule text, and optional KQL example

            When you are ready to propose a learning, include it in your response using this exact format:

            ```learning
            {
                "title": "Short descriptive title",
                "ruleText": "Clear, concise instruction that the AI should follow in future queries",
                "kqlExample": "Optional KQL example demonstrating the rule (or null if not applicable)"
            }
            ```

            Guidelines for the learning:
            - The title should be 3-8 words, descriptive of the rule
            - The ruleText should be a clear instruction (1-3 sentences) that the AI can follow
            - The kqlExample should be a concrete KQL snippet illustrating the rule (if applicable)
            - Only propose a learning when you're confident the user is satisfied with it
            - If the user wants to refine the learning, iterate with them until they're happy

            If the user hasn't provided enough information yet, ask questions to understand:
            - What specific pattern or rule they want to teach
            - When this rule should be applied
            - Any concrete examples
            """;
    }

    private static TeachingResult ParseTeachingResponse(string content)
    {
        LearningProposal? proposal = null;

        var learningStart = content.IndexOf("```learning", StringComparison.OrdinalIgnoreCase);
        if (learningStart >= 0)
        {
            var blockStart = content.IndexOf('\n', learningStart) + 1;
            var blockEnd = content.IndexOf("```", blockStart, StringComparison.Ordinal);
            if (blockEnd > blockStart)
            {
                var json = content[blockStart..blockEnd].Trim();
                try
                {
                    proposal = System.Text.Json.JsonSerializer.Deserialize<LearningProposal>(json, new System.Text.Json.JsonSerializerOptions
                    {
                        PropertyNameCaseInsensitive = true
                    });
                }
                catch
                {
                    // If parsing fails, the proposal remains null
                }
            }
        }

        // Build the display response (remove the learning block for clean display)
        var displayText = content;
        if (learningStart >= 0)
        {
            var endBlock = content.IndexOf("```", content.IndexOf('\n', learningStart) + 1, StringComparison.Ordinal);
            if (endBlock >= 0)
            {
                var beforeBlock = content[..learningStart].TrimEnd();
                var afterBlock = content[(endBlock + 3)..].TrimStart();
                displayText = string.IsNullOrEmpty(afterBlock)
                    ? beforeBlock
                    : $"{beforeBlock}\n\n{afterBlock}";
            }
        }

        return new TeachingResult
        {
            Response = displayText.Trim(),
            Proposal = proposal
        };
    }

    private static string BuildUserMessage(string userPrompt, string? existingKql)
    {
        if (string.IsNullOrWhiteSpace(existingKql))
        {
            return userPrompt;
        }

        return $"""
            Current KQL query:
            ```kql
            {existingKql}
            ```

            Requested change: {userPrompt}
            """;
    }

    private static KqlGenerationResult ParseResponse(string content)
    {
        // Extract KQL from markdown code block if present
        var kql = content;
        var explanation = string.Empty;

        var kqlStart = content.IndexOf("```kql", StringComparison.OrdinalIgnoreCase);
        if (kqlStart < 0)
            kqlStart = content.IndexOf("```kusto", StringComparison.OrdinalIgnoreCase);

        if (kqlStart >= 0)
        {
            explanation = content[..kqlStart].Trim();
            var blockStart = content.IndexOf('\n', kqlStart) + 1;
            var blockEnd = content.IndexOf("```", blockStart, StringComparison.Ordinal);
            if (blockEnd > blockStart)
            {
                kql = content[blockStart..blockEnd].Trim();
            }

            // Any text after the code block is also explanation
            var afterBlock = blockEnd + 3;
            if (afterBlock < content.Length)
            {
                var suffix = content[afterBlock..].Trim();
                if (!string.IsNullOrEmpty(suffix))
                {
                    explanation = string.IsNullOrEmpty(explanation)
                        ? suffix
                        : $"{explanation}\n\n{suffix}";
                }
            }
        }

        return new KqlGenerationResult
        {
            KqlQuery = kql,
            Explanation = explanation
        };
    }

    private static string BuildSystemPrompt(List<DashboardFilter> filters, WidgetType widgetType)
    {
        var filterContext = BuildFilterContext(filters);
        var widgetContext = GetWidgetTypeGuidance(widgetType);

        return $"""
            You are a KQL (Kusto Query Language) expert that generates queries for an Azure Log Analytics workspace containing Copilot/agent observability telemetry.

            ## Available Tables and Properties

            ### AppDependencies (primary table)
            Each row represents a dependency call (typically an LLM request).

            | Property | Path | Type | Description |
            |----------|------|------|-------------|
            | Chat Session ID | Properties["copilot_chat.chat_session_id"] | string | Unique identifier for an agent session in VS Code |
            | Agent Mode Name | Properties["copilot_chat.mode_name"] | string | The custom agent handling the request |
            | Agent Name | Properties["gen_ai.agent_name"] | string | Name of the agent handling the request |
            | User Request | Properties["copilot_chat.user_request"] | string | The prompt sent to the agent |
            | Service Name | Properties["service.name"] | string | The service emitting the telemetry (always "copilot-chat") |
            | User Email | Properties["user.email"] | string | Developer who initiated the session |
            | Operation Name | Properties["gen_ai.operation.name"] | string | Operation type: "invoke_agent", "execute_tool", etc. |
            | Tool Name | Properties["gen_ai.tool.name"] | string | Tool name (only on "execute_tool" operations) |
            | Repository URL | Properties["copilot_chat.repo.remote_url"] | string | Git remote URL of the active repository |
            | Request Model | Properties["gen_ai.request.model"] | string | LLM model used for the request |
            | Model ID (fallback) | Properties["ai.model_id"] | string | Alternative model identifier |
            | Input Tokens | Measurements["gen_ai.usage.input_tokens"] | double | Number of input tokens consumed |
            | Output Tokens | Measurements["gen_ai.usage.output_tokens"] | double | Number of output tokens generated |
            | Duration | DurationMs | double | Latency of the dependency call in milliseconds |
            | Timestamp | TimeGenerated | datetime | When the telemetry was recorded |

            ## Important Notes
            - The repository URL is NOT always present on every row. If you need to filter by repository, note that `copilot_chat.repo.remote_url` may only appear on certain telemetry entries within a session.
            - To reliably filter by repository, join via `copilot_chat.chat_session_id`:
              ```
              let RepoBySession = AppDependencies
              | where isnotempty(Properties["copilot_chat.repo.remote_url"])
              | summarize RepoUrl=take_any(tostring(Properties["copilot_chat.repo.remote_url"])) by SessionId=tostring(Properties["copilot_chat.chat_session_id"]);
              ```
            - Use `tostring(Properties["..."])` when comparing property values.
            - Use `todouble(Measurements["..."])` or `todouble(Properties["..."])` for numeric measurements.
            - For model identification, use: `coalesce(tostring(Properties["gen_ai.request.model"]), tostring(Properties["ai.model_id"]))`

            {filterContext}

            {widgetContext}

            ## Output Format
            Return your response in this format:
            1. A brief explanation of what the query does (1-2 sentences)
            2. The KQL query in a ```kql code block

            Do NOT include any `let` statements for filter variables — those are injected automatically by the system. Just reference them directly (e.g., `| where ... in (_filter_repositories)`).

            Produce a single, valid KQL query. Do not include multiple queries or union statements unless necessary for the metric requested.
            """;
    }

    private static string BuildFilterContext(List<DashboardFilter> filters)
    {
        if (filters.Count == 0)
            return "## Active Filters\nNo filters are configured on this dashboard.";

        var lines = new List<string> { "## Active Filters", "The following filter variables are automatically injected as `let` statements before your query runs. Reference them when appropriate:" };

        foreach (var filter in filters)
        {
            switch (filter.FilterType)
            {
                case DashboardFilterType.Repository when filter.Values.Count > 0:
                    lines.Add($"- `_filter_repositories` (dynamic array) — filter by repository URL. Use: `| where tostring(Properties[\"copilot_chat.repo.remote_url\"]) in (_filter_repositories)` (or join pattern for reliable filtering)");
                    break;
                case DashboardFilterType.Developer when filter.Values.Count > 0:
                    lines.Add($"- `_filter_developers` (dynamic array) — filter by developer. Use: `| where tostring(Properties[\"user.email\"]) in (_filter_developers)`");
                    break;
                case DashboardFilterType.TimeRange when filter.Values.Count > 0:
                    lines.Add($"- `_filter_timerange` (string) — time range filter value: \"{filter.Values[0]}\"");
                    break;
                case DashboardFilterType.Custom when !string.IsNullOrEmpty(filter.Key) && filter.Values.Count > 0:
                    var sanitizedKey = filter.Key.ToLowerInvariant().Replace(" ", "_");
                    lines.Add($"- `_filter_{sanitizedKey}` (dynamic array) — custom filter for \"{filter.Key}\"");
                    break;
            }
        }

        return string.Join("\n", lines);
    }

    private static string GetWidgetTypeGuidance(WidgetType widgetType)
    {
        return widgetType switch
        {
            WidgetType.MetricCard => """
                ## Widget Type: Metric Card
                The query should return a single row with one numeric value (the metric). Optionally a second column as a label.
                Example output shape: | Count | or | Value | Label |
                """,
            WidgetType.LineChart => """
                ## Widget Type: Line Chart
                The query should return rows with two columns: a time-based or ordered category (first column) and a numeric value (second column).
                Example output shape: | TimeGenerated | Requests |
                Use `bin(TimeGenerated, ...)` for time series or ordered string categories.
                """,
            WidgetType.BarChart => """
                ## Widget Type: Bar Chart
                The query should return rows with two columns: a category (first column) and a numeric value (second column).
                Example output shape: | Model | Requests |
                Order by the value column descending for best visualization.
                """,
            WidgetType.PieChart => """
                ## Widget Type: Pie Chart
                The query should return rows with two columns: a category/label (first column) and a numeric value (second column).
                Example output shape: | Category | Count |
                Limit to ~10 categories maximum for readability.
                """,
            WidgetType.Table => """
                ## Widget Type: Table
                The query can return multiple columns and rows. The table will display all columns.
                Return meaningful column names and limit rows to a reasonable number (use `| take` or `| top` if needed).
                """,
            _ => ""
        };
    }
}
