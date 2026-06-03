using AgentObservability.Dashboard.Services;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Phase 10 guardrail: <see cref="WidgetQueryService.ValidateQueryAllowed"/> must reject any query
/// referencing the retired raw telemetry tables or raw-content fields (case-insensitively), while
/// allowing benign aggregate-shaped queries.
/// </summary>
public sealed class WidgetQueryGuardrailTests
{
    [Theory]
    [InlineData("AppDependencies | summarize count()")]
    [InlineData("appdependencies | take 10")]
    [InlineData("APPDEPENDENCIES | count")]
    [InlineData("AppTraces | where Message contains \"x\"")]
    [InlineData("apptraces | take 1")]
    [InlineData("AppRequests | summarize count()")]
    [InlineData("traces | take 5")]
    [InlineData("dependencies | summarize count()")]
    [InlineData("union traces, dependencies | take 1")]
    public void RejectsForbiddenRawTables(string kql)
    {
        var error = WidgetQueryService.ValidateQueryAllowed(kql);
        Assert.NotNull(error);
    }

    [Theory]
    [InlineData("AppDependencies | extend r = Properties[\"user_request\"]")]
    [InlineData("T | project user_request")]
    [InlineData("T | project USER_REQUEST")]
    [InlineData("T | extend m = column_ifexists(\"gen_ai.input.messages\", \"\")")]
    [InlineData("T | extend m = Properties[\"gen_ai.output.messages\"]")]
    [InlineData("T | project tool.call.result")]
    [InlineData("T | project tool.call.arguments")]
    [InlineData("T | project system_instructions")]
    [InlineData("T | project reasoning_content")]
    [InlineData("T | project Reasoning_Content")]
    [InlineData("T | extend h = Properties[\"hook_pre\"]")]
    public void RejectsForbiddenRawContentFields(string kql)
    {
        var error = WidgetQueryService.ValidateQueryAllowed(kql);
        Assert.NotNull(error);
    }

    [Theory]
    [InlineData("T | extend r = Properties[\"copilot_chat.repo.remote_url\"]")]
    [InlineData("T | extend r = properties[\"x\"]")]
    [InlineData("T | extend r = PROPERTIES[\"x\"]")]
    [InlineData("T | extend m = Measurements[\"duration\"]")]
    [InlineData("T | extend m = measurements[\"duration\"]")]
    [InlineData("T | where tostring(Properties[\"user.email\"]) in (_filter_developers)")]
    public void RejectsRawPropertyAndMeasurementBags(string kql)
    {
        var error = WidgetQueryService.ValidateQueryAllowed(kql);
        Assert.NotNull(error);
    }

    [Theory]
    [InlineData("AggregateBuckets | summarize Requests = sum(interactionCount) by model")]
    [InlineData("AggregateBuckets | summarize Tokens = sum(inputTokens) + sum(outputTokens) by repository")]
    [InlineData("AggregateBuckets | summarize sum(interactionCount) by bin(timeBucket, 1h)")]
    [InlineData("AggregateBuckets | summarize Sessions = sum(distinctSessionCount) by developerId | top 10 by Sessions")]
    [InlineData("AggregateBuckets | summarize AvgMs = sum(durationMsSum) / sum(interactionCount) by toolName")]
    [InlineData("AggregateBuckets | where repository in (_filter_repositories) | summarize Requests = sum(interactionCount) by developerId")]
    public void AllowsBenignAggregateQueries(string kql)
    {
        var error = WidgetQueryService.ValidateQueryAllowed(kql);
        Assert.Null(error);
    }

    [Fact]
    public void DoesNotFalseMatchPropertiesWithoutBracket()
    {
        // A column literally named 'properties' (no '[' accessor) is not the raw property bag and
        // must not be rejected — the accessor guard requires the opening bracket.
        var error = WidgetQueryService.ValidateQueryAllowed(
            "AggregateBuckets | extend properties = interactionCount | project properties");
        Assert.Null(error);
    }

    [Fact]
    public void AllowsNullOrWhitespace()
    {
        Assert.Null(WidgetQueryService.ValidateQueryAllowed(""));
        Assert.Null(WidgetQueryService.ValidateQueryAllowed("   "));
    }

    // --- Flag-gated execution seam (the runtime wrapper ExecuteWidgetQueryAsync calls). ---

    [Theory]
    [InlineData("AppDependencies | take 1")]
    [InlineData("T | extend r = Properties[\"user_request\"]")]
    public void GetGuardrailError_BlocksRawQueries_InAggregateMode(string kql)
    {
        // exposeRawSessionDetail == false (the default): the guardrail is enforced.
        Assert.NotNull(WidgetQueryService.GetGuardrailError(kql, exposeRawSessionDetail: false));
    }

    [Theory]
    [InlineData("AppDependencies | take 1")]
    [InlineData("T | extend r = Properties[\"user_request\"]")]
    public void GetGuardrailError_BypassesRawQueries_InRollbackMode(string kql)
    {
        // exposeRawSessionDetail == true (one-release rollback): the guardrail is bypassed so the
        // raw Workflows/widget paths keep working with prior behavior.
        Assert.Null(WidgetQueryService.GetGuardrailError(kql, exposeRawSessionDetail: true));
    }

    [Fact]
    public void GetGuardrailError_AllowsBenignAggregateQuery_InAggregateMode()
    {
        Assert.Null(WidgetQueryService.GetGuardrailError(
            "AggregateBuckets | summarize sum(interactionCount) by model", exposeRawSessionDetail: false));
    }

    [Fact]
    public void DoesNotFalseMatchSubstringInAggregateField()
    {
        // 'dependencies' as a substring of a benign column name must NOT trip the table guard,
        // because the table guard is word-boundary anchored.
        var error = WidgetQueryService.ValidateQueryAllowed(
            "AggregateBuckets | extend toolDependenciesCount = interactionCount | project toolDependenciesCount");
        Assert.Null(error);
    }
}
