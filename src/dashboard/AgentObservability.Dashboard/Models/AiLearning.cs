namespace AgentObservability.Dashboard.Models;

public sealed class AiLearning
{
    public string Id { get; init; } = Guid.NewGuid().ToString();
    public string Title { get; init; } = string.Empty;
    public string RuleText { get; init; } = string.Empty;
    public string? KqlExample { get; init; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
}
