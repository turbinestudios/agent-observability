using AgentObservability.Dashboard.Models;

namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Org-level analytics for the Context Hotspots page. Reads the privacy-scoped context-insights
/// store and ranks customization files by a transparent composite hotspot score so a team can
/// review, per repository and per sprint, where to refine their context engineering.
/// </summary>
public interface IContextHotspotAnalyticsService
{
    /// <summary>
    /// Distinct repositories (excluding 'unknown') that have any context-insight rows in the
    /// lookback window, ordered alphabetically. Drives the repository filter on the page.
    /// </summary>
    Task<IReadOnlyList<string>> GetRepositoriesAsync(TimeSpan lookback, CancellationToken cancellationToken = default);

    /// <summary>
    /// Ranked context-file hotspots over the lookback window. When <paramref name="repository"/> is
    /// null/empty the result spans all repositories; otherwise it is scoped to that repository.
    /// Ordered by descending <see cref="ContextHotspot.HotspotScore"/>.
    /// </summary>
    Task<IReadOnlyList<ContextHotspot>> GetHotspotsAsync(
        string? repository,
        TimeSpan lookback,
        CancellationToken cancellationToken = default);
}
