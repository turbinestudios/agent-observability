namespace AgentObservability.Dashboard.Services;

/// <summary>
/// Configuration for AI-powered KQL query generation ('AiQuery' section). Bound from appsettings.
/// </summary>
/// <remarks>
/// Phase 10 (privacy-first refactor): the AI query assistant now generates aggregate-only KQL and
/// is guarded so it cannot reference raw telemetry tables/content. This option is the rollback
/// switch: flip <see cref="Enabled"/> to false to disable AI query generation (and the teaching
/// flow) entirely for one release without removing the feature.
/// </remarks>
public sealed class AiQueryOptions
{
    public const string SectionName = "AiQuery";

    /// <summary>
    /// When true (default), the AI query assistant is available: KQL generation and the teaching
    /// flow run normally. When false, those flows short-circuit with a disabled message and the
    /// assistant UI surfaces a disabled state instead of the generate controls.
    /// </summary>
    public bool Enabled { get; set; } = true;
}
