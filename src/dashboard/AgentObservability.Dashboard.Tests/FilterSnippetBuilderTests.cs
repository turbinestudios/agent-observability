using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Phase 10 (privacy-first refactor): the dashboard widget editor's filter snippets must be
/// AGGREGATE-shaped when the master switch <see cref="WebUxOptions.ExposeRawSessionDetail"/> is
/// false (default), and only emit the legacy raw <c>Properties[...]</c> form during one-release
/// rollback (true). <see cref="FilterSnippetBuilder.Build"/> is the pure selection helper.
/// </summary>
public sealed class FilterSnippetBuilderTests
{
    private static List<DashboardFilter> RepoDevAndCustom() =>
    [
        new DashboardFilter { FilterType = DashboardFilterType.Repository, Values = ["https://x/y"] },
        new DashboardFilter { FilterType = DashboardFilterType.Developer, Values = ["dev_1"] },
        new DashboardFilter { FilterType = DashboardFilterType.Custom, Key = "Agent Mode", Values = ["plan"] },
    ];

    [Fact]
    public void AggregateMode_EmitsAggregateColumnSnippets_NoRawPropertyBag()
    {
        var snippets = FilterSnippetBuilder.Build(RepoDevAndCustom(), exposeRaw: false);

        Assert.Equal(3, snippets.Count);
        foreach (var snippet in snippets)
        {
            Assert.DoesNotContain("Properties[", snippet.Kql, StringComparison.OrdinalIgnoreCase);
            // Every aggregate-only snippet must survive the execution guardrail.
            Assert.Null(WidgetQueryService.ValidateQueryAllowed("AggregateBuckets " + snippet.Kql));
        }

        Assert.Contains(snippets, s => s.Kql == "| where repository in (_filter_repositories)");
        Assert.Contains(snippets, s => s.Kql == "| where developerId in (_filter_developers)");
        // Custom 'Agent Mode' -> sanitized aggregate column/var 'agent_mode'.
        Assert.Contains(snippets, s => s.Kql == "| where agent_mode in (_filter_agent_mode)");
    }

    [Fact]
    public void RollbackMode_EmitsRawPropertyBagSnippets()
    {
        var snippets = FilterSnippetBuilder.Build(RepoDevAndCustom(), exposeRaw: true);

        Assert.Equal(3, snippets.Count);
        Assert.All(snippets, s => Assert.Contains("Properties[", s.Kql));
        Assert.Contains(snippets, s =>
            s.Kql == "| where tostring(Properties[\"copilot_chat.repo.remote_url\"]) in (_filter_repositories)");
        Assert.Contains(snippets, s =>
            s.Kql == "| where tostring(Properties[\"user.email\"]) in (_filter_developers)");
    }

    [Fact]
    public void CustomFilterWithoutKey_IsSkipped()
    {
        var filters = new List<DashboardFilter>
        {
            new DashboardFilter { FilterType = DashboardFilterType.Custom, Key = "", Values = ["v"] },
        };

        Assert.Empty(FilterSnippetBuilder.Build(filters, exposeRaw: false));
        Assert.Empty(FilterSnippetBuilder.Build(filters, exposeRaw: true));
    }
}
