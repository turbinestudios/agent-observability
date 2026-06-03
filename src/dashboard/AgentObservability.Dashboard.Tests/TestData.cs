using AgentObservability.Dashboard.Models.Ingestion;

namespace AgentObservability.Dashboard.Tests;

/// <summary>Shared builders for schema-valid aggregate batches used across the test suite.</summary>
internal static class TestData
{
    public const string ValidDeveloperId = "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3";

    public static readonly double[] CanonicalBoundsMs =
        [100, 250, 500, 1000, 2000, 5000, 10000, 30000];

    public static LatencyHistogram ValidHistogram() => new()
    {
        BoundsMs = CanonicalBoundsMs,
        Counts = [0, 1, 2, 3, 4, 1, 1, 0, 0],
    };

    public static AggregateBucket ValidBucket(string rowKey = "row-1") => new()
    {
        RowKey = rowKey,
        BucketStart = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero),
        BucketDurationSeconds = 1800,
        Repository = "https://github.com/turbinestudios/agent-observability",
        Model = "gpt-4.1",
        AgentMode = "agent",
        Operation = "chat",
        InteractionCount = 12,
        SuccessCount = 11,
        ErrorCount = 1,
        InputTokens = 84210,
        OutputTokens = 9043,
        CachedTokens = 61200,
        ReasoningTokens = 1500,
        DurationMsSum = 41230.0,
        LatencyHistogram = ValidHistogram(),
        DistinctSessionCount = 3,
        LastActivityAtMs = 1780387740000,
    };

    public static AggregateBatch ValidBatch(params AggregateBucket[] buckets) => new()
    {
        SchemaVersion = "1.0",
        BatchId = "batch-abc-123",
        GeneratedAt = new DateTimeOffset(2026, 6, 2, 9, 15, 0, TimeSpan.Zero),
        ToolVersion = "1.4.2",
        PseudonymousDeveloperId = ValidDeveloperId,
        Window = new AggregateWindow
        {
            Start = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero),
            End = new DateTimeOffset(2026, 6, 2, 8, 30, 0, TimeSpan.Zero),
        },
        Buckets = buckets.Length > 0 ? buckets : [ValidBucket(), ValidBucket("row-2")],
    };

    /// <summary>A clean batch as JSON (no extra fields).</summary>
    public const string ValidBatchJson = """
        {
          "schemaVersion": "1.0",
          "batchId": "batch-abc-123",
          "generatedAt": "2026-06-02T09:15:00Z",
          "toolVersion": "1.4.2",
          "pseudonymousDeveloperId": "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3",
          "window": { "start": "2026-06-02T08:00:00Z", "end": "2026-06-02T08:30:00Z" },
          "buckets": [
            {
              "rowKey": "a1b2c3d4",
              "bucketStart": "2026-06-02T08:00:00Z",
              "bucketDurationSeconds": 1800,
              "repository": "https://github.com/turbinestudios/agent-observability",
              "model": "gpt-4.1",
              "agentMode": "agent",
              "operation": "chat",
              "interactionCount": 12,
              "successCount": 11,
              "errorCount": 1,
              "inputTokens": 84210,
              "outputTokens": 9043,
              "cachedTokens": 61200,
              "reasoningTokens": 1500,
              "durationMsSum": 41230.0,
              "latencyHistogram": {
                "boundsMs": [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
                "counts": [0, 1, 2, 3, 4, 1, 1, 0, 0]
              },
              "distinctSessionCount": 3,
              "lastActivityAtMs": 1780387740000
            }
          ]
        }
        """;

    /// <summary>The same batch but with a forbidden raw field injected into a bucket.</summary>
    public const string BatchJsonWithForbiddenField = """
        {
          "schemaVersion": "1.0",
          "batchId": "batch-abc-123",
          "generatedAt": "2026-06-02T09:15:00Z",
          "toolVersion": "1.4.2",
          "pseudonymousDeveloperId": "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3",
          "window": { "start": "2026-06-02T08:00:00Z", "end": "2026-06-02T08:30:00Z" },
          "buckets": [
            {
              "rowKey": "a1b2c3d4",
              "bucketStart": "2026-06-02T08:00:00Z",
              "bucketDurationSeconds": 1800,
              "repository": "https://github.com/turbinestudios/agent-observability",
              "model": "gpt-4.1",
              "agentMode": "agent",
              "operation": "chat",
              "copilot_chat.user_request": "what is the meaning of life?",
              "interactionCount": 12,
              "successCount": 11,
              "errorCount": 1,
              "inputTokens": 84210,
              "outputTokens": 9043,
              "cachedTokens": 61200,
              "durationMsSum": 41230.0,
              "latencyHistogram": {
                "boundsMs": [100, 250, 500, 1000, 2000, 5000, 10000, 30000],
                "counts": [0, 1, 2, 3, 4, 1, 1, 0, 0]
              },
              "distinctSessionCount": 3
            }
          ]
        }
        """;
}
