namespace AgentObservability.Dashboard.Services.AgentRelay;

/// <summary>
/// Configuration for the autonomous-agent OTLP relay ('AgentRelay' section). The relay is the cloud
/// landing spot that an alert-triggered Copilot CLI agent PUSHES raw OTLP to (<c>POST
/// /agent-otlp/v1/traces</c>) and that the VS Code extension PULLS from (<c>GET
/// /agent-otlp/batches</c>). Raw bodies are stored verbatim in blob storage, org-scoped by the
/// authenticated key.
/// </summary>
public sealed class AgentRelayOptions
{
    public const string SectionName = "AgentRelay";

    /// <summary>
    /// Master switch for the relay endpoints. When false, every <c>/agent-otlp/*</c> route returns
    /// 503 (the health endpoint still answers, reporting <c>enabled=false</c>). Default false — the
    /// relay is opt-in and only enabled where blob storage is wired.
    /// </summary>
    public bool Enabled { get; set; }

    /// <summary>Blob container that holds the raw OTLP batches. Created on startup if absent.</summary>
    public string ContainerName { get; set; } = "agent-otlp-raw";

    /// <summary>Reject a pushed batch larger than this many bytes with 413. Default 5 MiB.</summary>
    public int MaxBatchBytes { get; set; } = 5 * 1024 * 1024;

    /// <summary>Upper bound the list endpoint clamps <c>limit</c> to (DoS guard). Default 500.</summary>
    public int MaxListLimit { get; set; } = 500;

    /// <summary>
    /// Retention for stored batches in days. Enforced authoritatively by a blob lifecycle rule in
    /// infrastructure; surfaced here for documentation/parity. Default 7.
    /// </summary>
    public int RetentionDays { get; set; } = 7;
}
