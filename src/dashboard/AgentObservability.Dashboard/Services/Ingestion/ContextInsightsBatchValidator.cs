using System.Text.RegularExpressions;
using AgentObservability.Dashboard.Models.Ingestion;

namespace AgentObservability.Dashboard.Services.Ingestion;

/// <summary>
/// Server-side privacy guard for <see cref="ContextInsightsBatch"/>. The client is NEVER trusted:
/// even though the extension produces schema-valid batches and the JSON Schema also enforces these
/// rules, this validator re-checks them on the server as defense-in-depth.
///
/// The MOST important check here is <see cref="ValidateContextFile"/>: this is the first contract
/// to convey file paths to the cloud, so the validator independently enforces that every
/// <c>contextFile</c> is a repo-relative POSIX path that (1) has no <c>..</c> traversal, (2) has no
/// drive letter / leading slash / backslash, (3) uses only a safe charset, and (4) ends with an
/// allowlisted customization-file suffix. A path that could carry an absolute location, a home
/// directory, a username, or a non-customization (source/doc) file cannot pass.
/// </summary>
public sealed partial class ContextInsightsBatchValidator
{
    private const string ExpectedSchemaVersion = "1.0";
    private const int ExpectedBucketDurationSeconds = 1800;

    private static readonly HashSet<string> AllowedCategories =
        new(StringComparer.Ordinal) { "instruction", "skill", "agent", "hook", "prompt" };

    [GeneratedRegex(@"^dev_[0-9a-f]{32}$")]
    private static partial Regex DeveloperIdRegex();

    [GeneratedRegex(@"^(unknown|https?://[A-Za-z0-9.\-]+(:[0-9]+)?/[^\s@?#]+)$")]
    private static partial Regex RepositoryRegex();

    // semver (matches the schema's toolVersion pattern).
    [GeneratedRegex(@"^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.\-]+)?$")]
    private static partial Regex ToolVersionRegex();

    // Repo-relative POSIX customization path; identical to the schema's contextFile pattern:
    //  - negative lookahead forbids any '..' path segment (no traversal),
    //  - safe segment charset [A-Za-z0-9_.-] only (no whitespace, '@', '?', '#', ':', '\', leading '/'),
    //  - the filename MUST be an allowlisted customization suffix or known root/skill file.
    [GeneratedRegex(@"^(?!.*(?:^|/)\.\.(?:/|$))(?:[A-Za-z0-9_.-]+/)*(?:[A-Za-z0-9_.-]+\.(?:instructions|prompt|agent|skill)\.md|copilot-instructions\.md|AGENTS\.md|CLAUDE\.md|SKILL\.md)$")]
    private static partial Regex ContextFileRegex();

    /// <summary>
    /// Validates a deserialized batch. Returns an empty list when valid; otherwise one human-readable
    /// error string per problem found. Callers surface these in a 400 Problem response.
    /// </summary>
    public IReadOnlyList<string> Validate(ContextInsightsBatch batch)
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

        if (batch.Rows is null)
        {
            errors.Add("rows is required (an empty array is valid).");
            return errors;
        }

        for (var i = 0; i < batch.Rows.Count; i++)
        {
            ValidateRow(batch.Rows[i], i, errors);
        }

        return errors;
    }

    private static void ValidateRow(ContextFileRow row, int index, List<string> errors)
    {
        var prefix = $"rows[{index}]";

        if (string.IsNullOrEmpty(row.RowKey) || row.RowKey.Length > 128)
        {
            errors.Add($"{prefix}.rowKey must be a non-empty string of at most 128 characters.");
        }

        if (row.BucketStart == default)
        {
            errors.Add($"{prefix}.bucketStart must be present.");
        }

        if (row.BucketDurationSeconds != ExpectedBucketDurationSeconds)
        {
            errors.Add($"{prefix}.bucketDurationSeconds must be {ExpectedBucketDurationSeconds} but was {row.BucketDurationSeconds}.");
        }

        ValidateRepository(row.Repository, prefix, errors);
        ValidateContextFile(row.ContextFile, prefix, errors);

        if (string.IsNullOrEmpty(row.Category) || !AllowedCategories.Contains(row.Category))
        {
            errors.Add($"{prefix}.category must be one of instruction, skill, agent, hook, prompt.");
        }

        // Non-negative measures.
        if (row.AppliedCount < 0)
        {
            errors.Add($"{prefix}.appliedCount must be >= 0.");
        }

        if (row.SkippedCount < 0)
        {
            errors.Add($"{prefix}.skippedCount must be >= 0.");
        }

        if (row.EstTokensSum < 0)
        {
            errors.Add($"{prefix}.estTokensSum must be >= 0.");
        }

        if (row.EstTokensMax < 0)
        {
            errors.Add($"{prefix}.estTokensMax must be >= 0.");
        }

        if (row.SessionsWithErrorCount < 0)
        {
            errors.Add($"{prefix}.sessionsWithErrorCount must be >= 0.");
        }

        if (row.SessionsWithDeviationCount < 0)
        {
            errors.Add($"{prefix}.sessionsWithDeviationCount must be >= 0.");
        }

        if (row.DistinctSessionCount < 0)
        {
            errors.Add($"{prefix}.distinctSessionCount must be >= 0.");
        }

        if (row.LastActivityAtMs is < 0)
        {
            errors.Add($"{prefix}.lastActivityAtMs must be >= 0.");
        }

        ValidateSkipReasonCounts(row, prefix, errors);
    }

    private static void ValidateRepository(string repository, string prefix, List<string> errors)
    {
        if (string.IsNullOrEmpty(repository) || repository.Length > 512)
        {
            errors.Add($"{prefix}.repository must be a non-empty string of at most 512 characters.");
            return;
        }

        // DEFENSE-IN-DEPTH: reject any credential/free-text-bearing remote even though the regex
        // below also forbids these characters.
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
    /// The privacy-critical path check. Independently rejects anything that is not a repo-relative,
    /// allowlisted customization path before the regex even runs, so an absolute path / home dir /
    /// drive letter / traversal / non-customization file can never reach storage.
    /// </summary>
    private static void ValidateContextFile(string contextFile, string prefix, List<string> errors)
    {
        if (string.IsNullOrEmpty(contextFile) || contextFile.Length > 256)
        {
            errors.Add($"{prefix}.contextFile must be a non-empty string of at most 256 characters.");
            return;
        }

        // DEFENSE-IN-DEPTH: explicitly forbid the dangerous shapes before the allowlist regex.
        if (contextFile.IndexOf('\\') >= 0 ||
            contextFile.IndexOf(':') >= 0 ||
            contextFile.StartsWith('/') ||
            contextFile.Contains("..", StringComparison.Ordinal) ||
            contextFile.IndexOf('@') >= 0 ||
            contextFile.IndexOf('?') >= 0 ||
            contextFile.IndexOf('#') >= 0 ||
            contextFile.Any(char.IsWhiteSpace))
        {
            errors.Add($"{prefix}.contextFile must be a repo-relative POSIX path with no drive letter, leading '/', '\\', ':', '..', whitespace, '@', '?', or '#'.");
            return;
        }

        if (!ContextFileRegex().IsMatch(contextFile))
        {
            errors.Add($"{prefix}.contextFile must be a repo-relative path ending in an allowlisted customization suffix (*.instructions.md, *.prompt.md, *.agent.md, *.skill.md) or a known root/skill file (copilot-instructions.md, AGENTS.md, CLAUDE.md, SKILL.md).");
        }
    }

    /// <summary>
    /// skipReasonCounts is OPTIONAL. When present, every bucket must be non-negative and the sum of
    /// the recognized reasons must not exceed <see cref="ContextFileRow.SkippedCount"/> (they
    /// partition the skips). The DTO already rejects unknown keys via UnmappedMemberHandling.Disallow.
    /// </summary>
    private static void ValidateSkipReasonCounts(ContextFileRow row, string prefix, List<string> errors)
    {
        var counts = row.SkipReasonCounts;
        if (counts is null)
        {
            return;
        }

        if (counts.ApplyToNoMatch is < 0)
        {
            errors.Add($"{prefix}.skipReasonCounts.applyToNoMatch must be >= 0.");
        }

        if (counts.Other is < 0)
        {
            errors.Add($"{prefix}.skipReasonCounts.other must be >= 0.");
        }

        var sum = (long)(counts.ApplyToNoMatch ?? 0) + (counts.Other ?? 0);
        if (sum > row.SkippedCount)
        {
            errors.Add($"{prefix}.skipReasonCounts must sum to <= skippedCount.");
        }
    }
}
