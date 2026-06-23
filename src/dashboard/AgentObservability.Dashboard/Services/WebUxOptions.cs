namespace AgentObservability.Dashboard.Services;

/// <summary>
/// Configuration for the web UX split ('WebUx' section). Bound from appsettings.
/// </summary>
/// <remarks>
/// Phase 9 (privacy-first refactor): individual raw session/interaction detail moved to the
/// VS Code 'Agent Observability (Local)' extension. The org dashboard exposes only aggregate,
/// privacy-preserving views by default. This option is the rollback switch for one release.
/// </remarks>
public sealed class WebUxOptions
{
    public const string SectionName = "WebUx";

    /// <summary>
    /// When true, the org dashboard re-exposes raw per-session / per-interaction detail
    /// (RepositoryDetail session list and SessionDetail interaction timeline), querying the
    /// legacy raw Log Analytics tables. This is a temporary rollback path for one release.
    /// Default <c>false</c>: raw detail is hidden and lives only on developers' machines.
    /// </summary>
    public bool ExposeRawSessionDetail { get; set; }
}
