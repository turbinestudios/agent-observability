namespace AgentObservability.Dashboard.Models;

/// <summary>
/// A ranked context-engineering "hotspot": one customization file (instruction/skill/prompt/agent/
/// hook) in a repository, summarized over a sprint window with the four review signals the team
/// cares about during a retrospective:
/// <list type="number">
/// <item><description><b>Skipped</b> — discovered but not applied (often a misconfigured
/// <c>applyTo</c>); wasted context-engineering effort.</description></item>
/// <item><description><b>Token weight</b> — oversized / token-heavy files that pressure the context
/// budget.</description></item>
/// <item><description><b>Friction co-occurrence</b> — sessions where the file was applied AND an
/// error or workflow deviation occurred. CO-OCCURRENCE ONLY — never a causal claim.</description></item>
/// <item><description><b>Frequency</b> — how often the file is applied; high-impact artifacts worth
/// investing in.</description></item>
/// </list>
/// The sub-scores are normalized to [0,1] and combined into <see cref="HotspotScore"/> (0..100) by
/// <see cref="Services.Analytics.ContextHotspotAnalyticsService"/>; the page shows every raw signal
/// alongside the score so the ranking is transparent and explainable.
/// </summary>
public sealed record ContextHotspot
{
    // Dimensions.
    public required string Repository { get; init; }
    public required string ContextFile { get; init; }
    public required string Category { get; init; }

    // Raw signals (summed/maxed across the window).
    public int AppliedCount { get; init; }
    public int SkippedCount { get; init; }
    public int SkipApplyToNoMatchCount { get; init; }
    public int SkipOtherCount { get; init; }
    public long EstTokensSum { get; init; }
    public long MaxEstTokens { get; init; }
    public int SessionsWithErrorCount { get; init; }
    public int SessionsWithDeviationCount { get; init; }
    public int DistinctDeveloperCount { get; init; }
    public DateTimeOffset LastSeen { get; init; }

    // Normalized sub-scores [0,1] and composite [0,100], assigned by the analytics service.
    public double SkipScore { get; init; }
    public double TokenScore { get; init; }
    public double FrictionScore { get; init; }
    public double FrequencyScore { get; init; }
    public double HotspotScore { get; init; }

    /// <summary>Mean estimated token weight over applied sessions (estTokensSum / appliedCount).</summary>
    public double AverageEstTokens => AppliedCount > 0 ? (double)EstTokensSum / AppliedCount : 0;

    /// <summary>Fraction of discoveries that were skipped (skipped / (applied + skipped)).</summary>
    public double SkipRate => (AppliedCount + SkippedCount) > 0
        ? (double)SkippedCount / (AppliedCount + SkippedCount)
        : 0;
}
