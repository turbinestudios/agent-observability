namespace AgentObservability.Dashboard.Models;

public enum DashboardFilterType
{
    Repository,
    TimeRange,
    Developer,
    Custom
}

public sealed class DashboardFilter
{
    public DashboardFilterType FilterType { get; set; } = DashboardFilterType.Repository;
    public string Key { get; set; } = string.Empty;
    public List<string> Values { get; set; } = [];
}
