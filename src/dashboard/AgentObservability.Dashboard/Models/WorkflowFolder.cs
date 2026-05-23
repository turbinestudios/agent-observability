namespace AgentObservability.Dashboard.Models;

public sealed class WorkflowFolder
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string? ParentFolderId { get; set; }
    public string Name { get; set; } = string.Empty;
    public int SortOrder { get; set; }
}
