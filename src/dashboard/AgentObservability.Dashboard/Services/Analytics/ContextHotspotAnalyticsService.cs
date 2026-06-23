using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Builds the ranked context-engineering hotspots shown on the Context Hotspots page.
/// <para>
/// Rows are read from <see cref="IContextInsightStore"/> for the configured org over a sprint-length
/// lookback window, grouped to one entry per (repository, contextFile, category), and scored with a
/// transparent composite of the four review signals. Each sub-score is normalized to [0,1]:
/// </para>
/// <list type="bullet">
/// <item><description><b>Skip</b> = skipped / (applied + skipped).</description></item>
/// <item><description><b>Token</b> = min(1, maxEstTokens / <see cref="TokenBudgetTokens"/>).</description></item>
/// <item><description><b>Friction</b> = min(1, (errorSessions + deviationSessions) / max(1, applied)).
/// Co-occurrence only — never a causal claim.</description></item>
/// <item><description><b>Frequency</b> = applied / max(applied across the result set).</description></item>
/// </list>
/// <para>
/// <see cref="ContextHotspot.HotspotScore"/> = 100 × (0.30·skip + 0.30·friction + 0.20·token +
/// 0.20·frequency). Weights favor actionable problems (misconfiguration + friction) while still
/// surfacing high-impact, frequently-applied files worth refining.
/// </para>
/// </summary>
public sealed class ContextHotspotAnalyticsService : IContextHotspotAnalyticsService
{
    /// <summary>Token count at which the oversized/token-weight sub-score saturates to 1.0.</summary>
    public const long TokenBudgetTokens = 2_000;

    private const double SkipWeight = 0.30;
    private const double FrictionWeight = 0.30;
    private const double TokenWeight = 0.20;
    private const double FrequencyWeight = 0.20;

    private const string UnknownRepository = "unknown";

    private readonly IContextInsightStore _store;
    private readonly AnalyticsOptions _options;
    private readonly TimeProvider _timeProvider;

    public ContextHotspotAnalyticsService(
        IContextInsightStore store,
        IOptions<AnalyticsOptions> options,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(store);
        ArgumentNullException.ThrowIfNull(options);

        _store = store;
        _options = options.Value;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<IReadOnlyList<string>> GetRepositoriesAsync(
        TimeSpan lookback,
        CancellationToken cancellationToken = default)
    {
        var rows = await ReadRowsAsync(lookback, cancellationToken).ConfigureAwait(false);

        return rows
            .Select(r => r.Repository)
            .Where(repo => !IsUnknownRepository(repo))
            .Distinct(StringComparer.Ordinal)
            .OrderBy(repo => repo, StringComparer.Ordinal)
            .ToList();
    }

    public async Task<IReadOnlyList<ContextHotspot>> GetHotspotsAsync(
        string? repository,
        TimeSpan lookback,
        CancellationToken cancellationToken = default)
    {
        var rows = await ReadRowsAsync(lookback, cancellationToken).ConfigureAwait(false);

        var scoped = string.IsNullOrWhiteSpace(repository)
            ? rows
            : rows.Where(r => string.Equals(r.Repository, repository, StringComparison.Ordinal)).ToList();

        if (scoped.Count == 0)
        {
            return [];
        }

        // Collapse buckets to one entry per customization file.
        var grouped = scoped
            .GroupBy(r => (r.Repository, r.ContextFile, r.Category))
            .Select(g => new
            {
                g.Key.Repository,
                g.Key.ContextFile,
                g.Key.Category,
                AppliedCount = g.Sum(r => r.AppliedCount),
                SkippedCount = g.Sum(r => r.SkippedCount),
                SkipApplyToNoMatchCount = g.Sum(r => r.SkipApplyToNoMatch ?? 0),
                SkipOtherCount = g.Sum(r => r.SkipOther ?? 0),
                EstTokensSum = g.Sum(r => r.EstTokensSum),
                MaxEstTokens = g.Max(r => r.EstTokensMax),
                SessionsWithErrorCount = g.Sum(r => r.SessionsWithErrorCount),
                SessionsWithDeviationCount = g.Sum(r => r.SessionsWithDeviationCount),
                // distinctSessionCount is per-bucket-distinct; summing across buckets is an
                // accepted upper-bound approximation of reach for the sprint window.
                DistinctDeveloperCount = g.Select(r => r.PseudonymousDeveloperId)
                    .Distinct(StringComparer.Ordinal).Count(),
                LastSeen = MaxLastSeen(g),
            })
            .ToList();

        var maxApplied = grouped.Max(g => g.AppliedCount);

        var hotspots = grouped
            .Select(g =>
            {
                var skipScore = Clamp01(SkipRate(g.AppliedCount, g.SkippedCount));
                var tokenScore = Clamp01((double)g.MaxEstTokens / TokenBudgetTokens);
                var frictionScore = Clamp01(
                    (double)(g.SessionsWithErrorCount + g.SessionsWithDeviationCount) / Math.Max(1, g.AppliedCount));
                var frequencyScore = maxApplied > 0 ? Clamp01((double)g.AppliedCount / maxApplied) : 0;

                var composite = 100.0 * (
                    (SkipWeight * skipScore) +
                    (FrictionWeight * frictionScore) +
                    (TokenWeight * tokenScore) +
                    (FrequencyWeight * frequencyScore));

                return new ContextHotspot
                {
                    Repository = g.Repository,
                    ContextFile = g.ContextFile,
                    Category = g.Category,
                    AppliedCount = g.AppliedCount,
                    SkippedCount = g.SkippedCount,
                    SkipApplyToNoMatchCount = g.SkipApplyToNoMatchCount,
                    SkipOtherCount = g.SkipOtherCount,
                    EstTokensSum = g.EstTokensSum,
                    MaxEstTokens = g.MaxEstTokens,
                    SessionsWithErrorCount = g.SessionsWithErrorCount,
                    SessionsWithDeviationCount = g.SessionsWithDeviationCount,
                    DistinctDeveloperCount = g.DistinctDeveloperCount,
                    LastSeen = g.LastSeen,
                    SkipScore = skipScore,
                    TokenScore = tokenScore,
                    FrictionScore = frictionScore,
                    FrequencyScore = frequencyScore,
                    HotspotScore = composite,
                };
            })
            .OrderByDescending(h => h.HotspotScore)
            .ThenByDescending(h => h.SkippedCount + h.SessionsWithErrorCount + h.SessionsWithDeviationCount)
            .ThenBy(h => h.ContextFile, StringComparer.Ordinal)
            .ToList();

        return hotspots;
    }

    private Task<IReadOnlyList<ContextFileInsightRecord>> ReadRowsAsync(
        TimeSpan lookback,
        CancellationToken cancellationToken)
    {
        var now = _timeProvider.GetUtcNow();
        return _store.QueryRowsAsync(_options.OrgId, now - lookback, now, cancellationToken);
    }

    private static double SkipRate(int applied, int skipped)
    {
        var total = applied + skipped;
        return total > 0 ? (double)skipped / total : 0;
    }

    private static double Clamp01(double value) => Math.Clamp(value, 0.0, 1.0);

    private static bool IsUnknownRepository(string repository) =>
        string.IsNullOrWhiteSpace(repository) ||
        string.Equals(repository, UnknownRepository, StringComparison.OrdinalIgnoreCase);

    private static DateTimeOffset MaxLastSeen(IEnumerable<ContextFileInsightRecord> records)
    {
        var last = DateTimeOffset.MinValue;
        foreach (var r in records)
        {
            var seen = r.LastActivityAtMs is { } ms
                ? DateTimeOffset.FromUnixTimeMilliseconds(ms)
                : r.BucketStart;
            if (seen > last)
            {
                last = seen;
            }
        }

        return last;
    }
}
