namespace AgentObservability.Dashboard.Models;

public sealed class TriggerCondition
{
    public string AttributeName { get; set; } = "tool.name";
    public string ExpectedValue { get; set; } = string.Empty;
}

public sealed class ManagedWorkflow
{
    public string Id { get; set; } = Guid.NewGuid().ToString();
    public string RepositoryId { get; set; } = string.Empty;
    public string Name { get; set; } = string.Empty;
    public List<TriggerCondition> TriggerConditions { get; set; } = [new()];
    public List<WorkflowStep> Steps { get; set; } = [];
}
