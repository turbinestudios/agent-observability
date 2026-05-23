namespace AgentObservability.Dashboard.Models;

public sealed class ManagedWorkflow
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string? FolderId { get; set; }
    public string Name { get; set; } = string.Empty;
    public string TriggerKqlQuery { get; set; } = string.Empty;
    public List<WorkflowStep> Steps { get; set; } = [];
}
