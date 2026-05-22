namespace AgentObservability.Dashboard.Models;

public sealed class CustomDashboard
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string? FolderId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string Description { get; set; } = string.Empty;
    public int GridColumns { get; set; } = 12;
    public List<DashboardFilter> Filters { get; set; } = [];
    public DateTimeOffset CreatedAt { get; set; } = DateTimeOffset.UtcNow;
    public DateTimeOffset UpdatedAt { get; set; } = DateTimeOffset.UtcNow;
}
