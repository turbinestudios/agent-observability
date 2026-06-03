using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Phase 10: the AI system prompt must describe the AGGREGATE data model and must NOT teach the
/// model about retired raw telemetry tables/fields. <see cref="KqlGenerationService.BuildSystemPrompt"/>
/// is reachable from the test project via InternalsVisibleTo.
/// </summary>
public sealed class KqlPromptTests
{
    private static string Build() =>
        KqlGenerationService.BuildSystemPrompt(new List<DashboardFilter>(), WidgetType.Table);

    [Fact]
    public void Prompt_DoesNotReference_RawTelemetryTables()
    {
        var prompt = Build();

        Assert.DoesNotContain("AppDependencies", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("AppTraces", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("AppRequests", prompt, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Prompt_DoesNotReference_RawContentFieldsOrPropertyBags()
    {
        var prompt = Build();

        Assert.DoesNotContain("Properties[", prompt);
        Assert.DoesNotContain("Measurements[", prompt);
        Assert.DoesNotContain("user_request", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("gen_ai.input.messages", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("reasoning_content", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("system_instructions", prompt, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Prompt_MentionsAggregateFields()
    {
        var prompt = Build();

        Assert.Contains("aggregate", prompt, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("interactionCount", prompt);
        Assert.Contains("timeBucket", prompt);
        Assert.Contains("durationMsSum", prompt);
        Assert.Contains("distinctSessionCount", prompt);
    }

    [Fact]
    public void Prompt_StatesHardConstraintAgainstRawTelemetry()
    {
        var prompt = Build();

        Assert.Contains("MUST NOT", prompt);
        Assert.Contains("raw telemetry table", prompt, StringComparison.OrdinalIgnoreCase);
    }
}
