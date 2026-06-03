using AgentObservability.Dashboard.Models;

namespace AgentObservability.Dashboard.Services;

/// <summary>
/// One insertable filter where-clause snippet for the widget/AI KQL editor.
/// </summary>
public readonly record struct FilterSnippet(string Label, string Kql);

/// <summary>
/// Pure builder for the filter where-clause snippets offered in the dashboard widget editor.
/// </summary>
/// <remarks>
/// Phase 10 (privacy-first refactor): the snippet shape is driven by the single master switch
/// <see cref="WebUxOptions.ExposeRawSessionDetail"/>.
/// <list type="bullet">
/// <item>Aggregate-only (default, <paramref name="exposeRaw"/> == false): emit AGGREGATE-column
/// snippets (<c>repository</c>, <c>developerId</c>, and a custom-key aggregate form) so the
/// generated query never references the raw <c>Properties[...]</c> bag (which the execution
/// guardrail would reject anyway).</item>
/// <item>Rollback (<paramref name="exposeRaw"/> == true): emit the legacy raw <c>Properties[...]</c>
/// snippets, preserving prior behavior for one release.</item>
/// </list>
/// Extracted as a pure static method so it is unit-testable without bUnit.
/// </remarks>
public static class FilterSnippetBuilder
{
    public static List<FilterSnippet> Build(IEnumerable<DashboardFilter> filters, bool exposeRaw)
    {
        var snippets = new List<FilterSnippet>();
        foreach (var filter in filters)
        {
            switch (filter.FilterType)
            {
                case DashboardFilterType.Repository:
                    snippets.Add(new FilterSnippet(
                        "Repository",
                        exposeRaw
                            ? "| where tostring(Properties[\"copilot_chat.repo.remote_url\"]) in (_filter_repositories)"
                            : "| where repository in (_filter_repositories)"));
                    break;
                case DashboardFilterType.Developer:
                    snippets.Add(new FilterSnippet(
                        "Developer",
                        exposeRaw
                            ? "| where tostring(Properties[\"user.email\"]) in (_filter_developers)"
                            : "| where developerId in (_filter_developers)"));
                    break;
                case DashboardFilterType.Custom when !string.IsNullOrEmpty(filter.Key):
                    var sanitizedKey = filter.Key.ToLowerInvariant().Replace(" ", "_");
                    snippets.Add(new FilterSnippet(
                        $"Custom: {filter.Key}",
                        exposeRaw
                            ? $"| where tostring(Properties[\"{filter.Key}\"]) in (_filter_{sanitizedKey})"
                            : $"| where {sanitizedKey} in (_filter_{sanitizedKey})"));
                    break;
            }
        }
        return snippets;
    }
}
