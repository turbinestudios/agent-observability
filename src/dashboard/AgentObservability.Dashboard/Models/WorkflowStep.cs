namespace AgentObservability.Dashboard.Models;

public sealed class WorkflowStep
{
    public int Order { get; set; }
    public string PropertyName { get; set; } = "tool.name";
    public string ExpectedValue { get; set; } = string.Empty;
}
