namespace AgentObservability.Dashboard.Models;

public sealed class WorkflowStep
{
    public int Order { get; set; }
    public string Name { get; set; } = string.Empty;
    public string KqlQuery { get; set; } = string.Empty;
}
