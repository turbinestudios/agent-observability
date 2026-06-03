using System.Text.RegularExpressions;
using AgentObservability.Dashboard.Models.Ingestion;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Server-side privacy guard for <see cref="AggregateBatch"/>. The client is NEVER trusted:
/// even though the extension produces schema-valid batches and the JSON Schema also enforces
/// these rules, this validator re-checks them on the server as defense-in-depth. In particular
/// it rejects any <c>repository</c> that could carry credentials/free text ('@', whitespace,
/// '?', '#') so a sanitization mistake in the producer cannot leak a PAT to storage.
/// </summary>
public sealed partial class AggregateBatchValidator
{
    private const string ExpectedSchemaVersion = "1.0";
    private const int ExpectedBucketDurationSeconds = 1800;

    private static readonly double[] CanonicalBoundsMs =
        [100, 250, 500, 1000, 2000, 5000, 10000, 30000];

    private const int ExpectedHistogramCountsLength = 9; // BoundsMs.Length + 1

    private static readonly HashSet<string> AllowedOperations =
        new(StringComparer.Ordinal) { "chat", "execute_tool", "execute_hook", "invoke_agent" };

    // The extension maps any unknown chat mode to 'custom' before sending; the server
    // re-enforces the closed set so a buggy/malicious client cannot ship free-text
    // (which could embed project/customer identifiers).
    private static readonly HashSet<string> AllowedAgentModes =
        new(StringComparer.Ordinal) { "default", "ask", "edit", "agent", "custom" };

    [GeneratedRegex(@"^dev_[0-9a-f]{32}$")]
    private static partial Regex DeveloperIdRegex();

    [GeneratedRegex(@"^(unknown|https?://[A-Za-z0-9.\-]+(:[0-9]+)?/[^\s@?#]+)$")]
    private static partial Regex RepositoryRegex();

    // semver (matches the schema's toolVersion pattern).
    [GeneratedRegex(@"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.\-]+)?$")]
    private static partial Regex ToolVersionRegex();

    // Model id: letters/digits and . _ - : / (e.g. claude-opus-4.6, openai/gpt-4o). No whitespace or '@'.
    [GeneratedRegex(@"^[A-Za-z0-9._:\-/]+$")]
    private static partial Regex ModelRegex();

    // Tool name: an identifier (built-in tool names + the literal 'custom'). No spaces/paths/PII.
    [GeneratedRegex(@"^[A-Za-z0-9_\-]+$")]
    private static partial Regex ToolNameRegex();

    // Branch name when present: git-ref-safe chars only (forbids whitespace, '@', '?', '#', control).
    [GeneratedRegex(@"^[A-Za-z0-9._\-/]+$")]
    private static partial Regex BranchRegex();

    /// <summary>
    /// Validates a deserialized batch. Returns an empty list when valid; otherwise one human-readable
    /// error string per problem found. Callers surface these in a 400 Problem response.
    /// </summary>
    public IReadOnlyList<string> Validate(AggregateBatch batch)
    {
        ArgumentNullException.ThrowIfNull(batch);

        var errors = new List<string>();

        if (!string.Equals(batch.SchemaVersion, ExpectedSchemaVersion, StringComparison.Ordinal))
        {
            errors.Add($"schemaVersion must be '{ExpectedSchemaVersion}' but was '{batch.SchemaVersion}'.");
        }

        if (string.IsNullOrWhiteSpace(batch.BatchId) || batch.BatchId.Length > 128)
        {
            errors.Add("batchId must be a non-empty string of at most 128 characters.");
        }

        if (string.IsNullOrWhiteSpace(batch.ToolVersion) || batch.ToolVersion.Length > 64 ||
            !ToolVersionRegex().IsMatch(batch.ToolVersion))
        {
            errors.Add("toolVersion must be a semantic version (e.g. '1.4.2') of at most 64 characters.");
        }

        if (batch.Window is null)
        {
            errors.Add("window is required.");
        }
        else if (batch.Window.End <= batch.Window.Start)
        {
            errors.Add("window.end must be greater than window.start.");
        }

        if (string.IsNullOrEmpty(batch.PseudonymousDeveloperId) ||
            !DeveloperIdRegex().IsMatch(batch.PseudonymousDeveloperId))
        {
            errors.Add("pseudonymousDeveloperId must match ^dev_[0-9a-f]{32}$.");
        }

        if (batch.Buckets is null)
        {
            errors.Add("buckets is required (an empty array is valid).");
            return errors;
        }

        for (var i = 0; i < batch.Buckets.Count; i++)
        {
            ValidateBucket(batch.Buckets[i], i, errors);
        }

        return errors;
    }

    private static void ValidateBucket(AggregateBucket bucket, int index, List<string> errors)
    {
        var prefix = $"buckets[{index}]";

        if (string.IsNullOrEmpty(bucket.RowKey) || bucket.RowKey.Length > 128)
        {
            errors.Add($"{prefix}.rowKey must be a non-empty string of at most 128 characters.");
        }

        if (bucket.BucketStart == default)
        {
            errors.Add($"{prefix}.bucketStart must be present.");
        }

        if (bucket.BucketDurationSeconds != ExpectedBucketDurationSeconds)
        {
            errors.Add($"{prefix}.bucketDurationSeconds must be {ExpectedBucketDurationSeconds} but was {bucket.BucketDurationSeconds}.");
        }

        ValidateRepository(bucket.Repository, prefix, errors);
        ValidateRepositoryBranch(bucket.RepositoryBranch, prefix, errors);

        if (string.IsNullOrEmpty(bucket.Model) || bucket.Model.Length > 128 || !ModelRegex().IsMatch(bucket.Model))
        {
            errors.Add($"{prefix}.model must be a non-empty model id (letters, digits, . _ - : /) of at most 128 characters.");
        }

        // agentMode is a closed set; do not trust the client to have mapped unknown modes to 'custom'.
        if (string.IsNullOrEmpty(bucket.AgentMode) || !AllowedAgentModes.Contains(bucket.AgentMode))
        {
            errors.Add($"{prefix}.agentMode must be one of default, ask, edit, agent, custom.");
        }

        if (string.IsNullOrEmpty(bucket.Operation) || !AllowedOperations.Contains(bucket.Operation))
        {
            errors.Add($"{prefix}.operation must be one of chat, execute_tool, execute_hook, invoke_agent.");
        }

        // toolName, when present, must be a bare identifier — not free text that could embed
        // a path / customer id (the extension maps third-party/MCP tools to 'custom').
        if (bucket.ToolName is { } toolName &&
            (toolName.Length == 0 || toolName.Length > 128 || !ToolNameRegex().IsMatch(toolName)))
        {
            errors.Add($"{prefix}.toolName, when present, must be an identifier (letters, digits, _ -) of at most 128 characters.");
        }

        // Non-negative measures.
        if (bucket.InteractionCount < 0)
        {
            errors.Add($"{prefix}.interactionCount must be >= 0.");
        }

        if (bucket.SuccessCount < 0)
        {
            errors.Add($"{prefix}.successCount must be >= 0.");
        }

        if (bucket.ErrorCount < 0)
        {
            errors.Add($"{prefix}.errorCount must be >= 0.");
        }

        if (bucket.InputTokens < 0)
        {
            errors.Add($"{prefix}.inputTokens must be >= 0.");
        }

        if (bucket.OutputTokens < 0)
        {
            errors.Add($"{prefix}.outputTokens must be >= 0.");
        }

        if (bucket.CachedTokens < 0)
        {
            errors.Add($"{prefix}.cachedTokens must be >= 0.");
        }

        if (bucket.ReasoningTokens is < 0)
        {
            errors.Add($"{prefix}.reasoningTokens must be >= 0.");
        }

        if (bucket.DurationMsSum < 0)
        {
            errors.Add($"{prefix}.durationMsSum must be >= 0.");
        }

        if (bucket.DistinctSessionCount < 0)
        {
            errors.Add($"{prefix}.distinctSessionCount must be >= 0.");
        }

        if (bucket.LastActivityAtMs is < 0)
        {
            errors.Add($"{prefix}.lastActivityAtMs must be >= 0.");
        }

        // successCount + errorCount partition interactionCount; they must not exceed it.
        // (long math avoids int overflow on adversarial inputs.)
        if (bucket.SuccessCount >= 0 && bucket.ErrorCount >= 0 &&
            (long)bucket.SuccessCount + bucket.ErrorCount > bucket.InteractionCount)
        {
            errors.Add($"{prefix}.successCount + errorCount must be <= interactionCount.");
        }

        ValidateHistogram(bucket.LatencyHistogram, prefix, errors);
    }

    private static void ValidateRepository(string repository, string prefix, List<string> errors)
    {
        if (string.IsNullOrEmpty(repository) || repository.Length > 512)
        {
            errors.Add($"{prefix}.repository must be a non-empty string of at most 512 characters.");
            return;
        }

        // DEFENSE-IN-DEPTH: reject any credential/free-text-bearing remote even though the regex
        // below also forbids these characters. Belt and suspenders for the privacy guarantee.
        if (repository.IndexOf('@') >= 0 ||
            repository.IndexOf('?') >= 0 ||
            repository.IndexOf('#') >= 0 ||
            repository.Any(char.IsWhiteSpace))
        {
            errors.Add($"{prefix}.repository must not contain '@', '?', '#', or whitespace (possible credential/PII leak).");
            return;
        }

        if (!RepositoryRegex().IsMatch(repository))
        {
            errors.Add($"{prefix}.repository must be 'unknown' or a sanitized https?://host/path URL.");
        }
    }

    /// <summary>
    /// repositoryBranch is OPTIONAL (omitted by default) and privacy-sensitive — branch names can
    /// embed feature/customer/ticket identifiers. When a client does send it, the server caps the
    /// length and restricts it to git-ref-safe characters rather than trusting the producer; it
    /// never stores arbitrary free text.
    /// </summary>
    private static void ValidateRepositoryBranch(string? branch, string prefix, List<string> errors)
    {
        if (branch is null)
        {
            return; // optional, and omitted by default by the extension.
        }

        if (branch.Length == 0 || branch.Length > 256 || !BranchRegex().IsMatch(branch))
        {
            errors.Add($"{prefix}.repositoryBranch, when present, must be a git-ref-safe name (letters, digits, . _ - /) of at most 256 characters.");
        }
    }

    private static void ValidateHistogram(LatencyHistogram? histogram, string prefix, List<string> errors)
    {
        if (histogram is null)
        {
            errors.Add($"{prefix}.latencyHistogram is required.");
            return;
        }

        if (histogram.BoundsMs is null || histogram.BoundsMs.Count != CanonicalBoundsMs.Length)
        {
            errors.Add($"{prefix}.latencyHistogram.boundsMs must have exactly {CanonicalBoundsMs.Length} elements.");
        }
        else
        {
            for (var i = 0; i < CanonicalBoundsMs.Length; i++)
            {
                if (histogram.BoundsMs[i] != CanonicalBoundsMs[i])
                {
                    errors.Add($"{prefix}.latencyHistogram.boundsMs must equal [100,250,500,1000,2000,5000,10000,30000].");
                    break;
                }
            }
        }

        if (histogram.Counts is null || histogram.Counts.Count != ExpectedHistogramCountsLength)
        {
            errors.Add($"{prefix}.latencyHistogram.counts must have exactly {ExpectedHistogramCountsLength} elements.");
        }
        else
        {
            for (var i = 0; i < histogram.Counts.Count; i++)
            {
                if (histogram.Counts[i] < 0)
                {
                    errors.Add($"{prefix}.latencyHistogram.counts must all be >= 0.");
                    break;
                }
            }
        }
    }
}
