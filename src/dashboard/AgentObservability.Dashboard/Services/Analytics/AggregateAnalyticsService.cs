using System.Globalization;

using AgentObservability.Dashboard.Models;
using AgentObservability.Dashboard.Services.Ingestion;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services.Analytics;

/// <summary>
/// Aggregate-backed <see cref="IAnalyticsService"/>. Reproduces the four legacy org-level outputs
/// from pre-summed buckets in <see cref="IAggregateStore"/>, applying the additive-vs-distinct
/// correctness rules from the aggregate payload schema (§9): additive measures (interaction count,
/// tokens, duration, histogram counts) are summed; distinct counts (repositories, developers,
/// models) are computed at query time over distinct dimension values; p95 is approximated from the
/// merged fixed-bound latency histogram.
/// </summary>
public sealed class AggregateAnalyticsService : IAnalyticsService
{
    private const string UnknownRepository = "unknown";

    /// <summary>Fixed histogram bounds (ms). Shared by every row so counts are element-wise mergeable.</summary>
    private static readonly double[] LatencyBoundsMs = [100, 250, 500, 1000, 2000, 5000, 10000, 30000];

    private readonly IAggregateStore _store;
    private readonly AnalyticsOptions _options;
    private readonly TimeProvider _timeProvider;

    public AggregateAnalyticsService(
        IAggregateStore store,
        IOptions<AnalyticsOptions> options,
        TimeProvider? timeProvider = null)
    {
        _store = store;
        _options = options.Value;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async Task<DashboardMetrics> GetDashboardMetricsAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        var buckets = await ReadBucketsAsync(lookback, cancellationToken).ConfigureAwait(false);

        if (buckets.Count == 0)
        {
            return new DashboardMetrics();
        }

        // The legacy overview query applies `where Repository != "unknown"` BEFORE the summarize that
        // computes TotalRequests, AverageLatencyMs, P95, ActiveRepositories AND ActiveDevelopers, so
        // every overview SCALAR excludes unknown-repo activity. (RequestVolume and ModelBreakdown come
        // from the separate, unfiltered legacy volume/model queries, so they include unknown — below.)
        var knownRepoBuckets = buckets.Where(b => !IsUnknownRepository(b.Repository)).ToList();

        var totalRequests = knownRepoBuckets.Sum(b => b.InteractionCount);
        var durationSum = knownRepoBuckets.Sum(b => b.DurationMsSum);

        var activeRepositories = knownRepoBuckets
            .Select(b => b.Repository)
            .Distinct(StringComparer.Ordinal)
            .Count();

        var activeDevelopers = knownRepoBuckets
            .Select(b => b.PseudonymousDeveloperId)
            .Distinct(StringComparer.Ordinal)
            .Count();

        // Request volume: sum interaction count per 30-min BucketStart across all dimensions,
        // ordered ascending. Label format: "MM-dd HH:mm" (local).
        var requestVolume = buckets
            .GroupBy(b => b.BucketStart)
            .OrderBy(g => g.Key)
            .Select(g => new TimeSeriesPoint
            {
                Timestamp = g.Key,
                Label = g.Key.ToLocalTime().ToString("MM-dd HH:mm", CultureInfo.InvariantCulture),
                Value = g.Sum(b => b.InteractionCount),
            })
            .ToList();

        // Model breakdown: sum interaction count per model, descending. Empty model is excluded to
        // match the legacy modelQuery `where isnotempty(...model...)`.
        var modelBreakdown = buckets
            .Where(b => !string.IsNullOrEmpty(b.Model))
            .GroupBy(b => b.Model, StringComparer.Ordinal)
            .Select(g => new NamedValue
            {
                Label = g.Key,
                Value = g.Sum(b => b.InteractionCount),
            })
            .OrderByDescending(v => v.Value)
            .ToList();

        return new DashboardMetrics
        {
            TotalRequests = totalRequests,
            AverageLatencyMs = totalRequests > 0 ? durationSum / totalRequests : 0,
            P95LatencyMs = ApproximateP95(MergeHistogram(knownRepoBuckets)),
            ActiveRepositories = activeRepositories,
            ActiveDevelopers = activeDevelopers,
            RequestVolume = requestVolume,
            ModelBreakdown = modelBreakdown,
        };
    }

    public async Task<IReadOnlyList<RepositoryActivitySummary>> GetRepositoryActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        var buckets = await ReadBucketsAsync(lookback, cancellationToken).ConfigureAwait(false);

        // Exclude "unknown" repository, like the legacy query.
        return buckets
            .Where(b => !IsUnknownRepository(b.Repository))
            .GroupBy(b => b.Repository, StringComparer.Ordinal)
            .Select(g =>
            {
                var requests = g.Sum(b => b.InteractionCount);
                var durationSum = g.Sum(b => b.DurationMsSum);

                return new RepositoryActivitySummary
                {
                    Repository = g.Key,
                    Requests = requests,
                    ActiveDevelopers = g.Select(b => b.PseudonymousDeveloperId).Distinct(StringComparer.Ordinal).Count(),
                    AverageLatencyMs = requests > 0 ? durationSum / requests : 0,
                    UniqueModels = g.Select(b => b.Model).Distinct(StringComparer.Ordinal).Count(),
                };
            })
            .OrderByDescending(r => r.Requests)
            .ToList();
    }

    public async Task<IReadOnlyList<DeveloperActivitySummary>> GetDeveloperActivityAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        var buckets = await ReadBucketsAsync(lookback, cancellationToken).ConfigureAwait(false);

        return buckets
            .GroupBy(b => (b.PseudonymousDeveloperId, b.Repository))
            .Select(g =>
            {
                var requests = g.Sum(b => b.InteractionCount);
                var durationSum = g.Sum(b => b.DurationMsSum);

                return new DeveloperActivitySummary
                {
                    // The pseudonymous id is the privacy-preserving replacement for the legacy user.email.
                    Developer = g.Key.PseudonymousDeveloperId,
                    Repository = g.Key.Repository,
                    Requests = requests,
                    AverageLatencyMs = requests > 0 ? durationSum / requests : 0,
                    UniqueModels = g.Select(b => b.Model).Distinct(StringComparer.Ordinal).Count(),
                    LastSeen = ResolveLastSeen(g),
                };
            })
            .OrderByDescending(d => d.Requests)
            .ToList();
    }

    public async Task<IReadOnlyList<NamedValue>> GetModelUsageAsync(TimeSpan lookback, CancellationToken cancellationToken = default)
    {
        var buckets = await ReadBucketsAsync(lookback, cancellationToken).ConfigureAwait(false);

        return buckets
            .Where(b => !string.IsNullOrEmpty(b.Model))
            .GroupBy(b => b.Model, StringComparer.Ordinal)
            .Select(g => new NamedValue
            {
                Label = g.Key,
                Value = g.Sum(b => b.InteractionCount),
                // Input + output tokens summed into SecondaryValue.
                SecondaryValue = g.Sum(b => (double)b.InputTokens) + g.Sum(b => (double)b.OutputTokens),
            })
            .OrderByDescending(v => v.Value)
            .ToList();
    }

    private async Task<IReadOnlyList<AggregateBucketRecord>> ReadBucketsAsync(TimeSpan lookback, CancellationToken cancellationToken)
    {
        var now = _timeProvider.GetUtcNow();
        return await _store.QueryBucketsAsync(_options.OrgId, now - lookback, now, cancellationToken).ConfigureAwait(false);
    }

    private static bool IsUnknownRepository(string repository)
    {
        return string.IsNullOrEmpty(repository) || string.Equals(repository, UnknownRepository, StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// LastSeen = max(LastActivityAtMs) (epoch ms -> DateTimeOffset). Falls back to the max
    /// BucketStart when no row in the group reports lastActivityAtMs.
    /// </summary>
    private static DateTimeOffset ResolveLastSeen(IEnumerable<AggregateBucketRecord> group)
    {
        long? maxMs = null;
        DateTimeOffset maxBucketStart = DateTimeOffset.MinValue;

        foreach (var record in group)
        {
            if (record.LastActivityAtMs is { } ms && (maxMs is null || ms > maxMs))
            {
                maxMs = ms;
            }

            if (record.BucketStart > maxBucketStart)
            {
                maxBucketStart = record.BucketStart;
            }
        }

        return maxMs is { } value
            ? DateTimeOffset.FromUnixTimeMilliseconds(value)
            : maxBucketStart;
    }

    /// <summary>
    /// Sums the latency histogram counts element-wise across all buckets over the fixed bounds.
    /// Returns a length-9 array (8 bounds + the +Inf overflow bucket). Tolerates rows whose stored
    /// CSV was shorter/longer than 9 (only the first 9 slots contribute).
    /// </summary>
    private static long[] MergeHistogram(IReadOnlyList<AggregateBucketRecord> buckets)
    {
        var merged = new long[LatencyBoundsMs.Length + 1];

        foreach (var bucket in buckets)
        {
            var counts = bucket.LatencyHistogramCounts;
            var limit = Math.Min(counts.Count, merged.Length);

            for (var index = 0; index < limit; index++)
            {
                merged[index] += counts[index];
            }
        }

        return merged;
    }

    /// <summary>
    /// Approximates p95 from the merged fixed-bound histogram: walk the cumulative distribution and
    /// return the upper bound of the bucket where the cumulative fraction crosses 0.95. The +Inf
    /// overflow bucket reports the top bound (30000). Approximate by construction (see schema §8).
    /// Returns 0 when there are no observations.
    /// </summary>
    private static double ApproximateP95(long[] merged)
    {
        var total = merged.Sum();

        if (total == 0)
        {
            return 0;
        }

        var threshold = 0.95 * total;
        long cumulative = 0;

        for (var index = 0; index < merged.Length; index++)
        {
            cumulative += merged[index];

            if (cumulative >= threshold)
            {
                // index < bounds length => the bucket's upper bound; the overflow bucket reports the top bound.
                return index < LatencyBoundsMs.Length
                    ? LatencyBoundsMs[index]
                    : LatencyBoundsMs[^1];
            }
        }

        return LatencyBoundsMs[^1];
    }
}
