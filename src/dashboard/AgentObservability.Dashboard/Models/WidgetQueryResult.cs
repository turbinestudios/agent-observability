namespace AgentObservability.Dashboard.Models;

public sealed class WidgetQueryResult
{
    public List<string> Columns { get; set; } = [];
    public List<Dictionary<string, object?>> Rows { get; set; } = [];
    public string? Error { get; set; }
}
