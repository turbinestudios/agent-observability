using AgentObservability.Dashboard.Models.Ingestion;

namespace AgentObservability.Dashboard.Tests;

/// <summary>Shared builders for schema-valid context-insights batches used across the test suite.</summary>
internal static class ContextInsightsTestData
{
    public const string ValidDeveloperId = "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3";

    public static ContextFileRow ValidRow(
        string rowKey = "ctx-row-1",
        string contextFile = ".github/instructions/security.instructions.md",
        string category = "instruction") => new()
    {
        RowKey = rowKey,
        BucketStart = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero),
        BucketDurationSeconds = 1800,
        Repository = "https://github.com/turbinestudios/agent-observability",
        ContextFile = contextFile,
        Category = category,
        AppliedCount = 9,
        SkippedCount = 2,
        SkipReasonCounts = new SkipReasonCounts { ApplyToNoMatch = 2 },
        EstTokensSum = 5400,
        EstTokensMax = 900,
        SessionsWithErrorCount = 1,
        SessionsWithDeviationCount = 1,
        DistinctSessionCount = 4,
        LastActivityAtMs = 1780387740000,
    };

    public static ContextInsightsBatch ValidBatch(params ContextFileRow[] rows) => new()
    {
        SchemaVersion = "1.0",
        BatchId = "ctx-batch-1",
        GeneratedAt = new DateTimeOffset(2026, 6, 2, 9, 15, 0, TimeSpan.Zero),
        ToolVersion = "0.1.19",
        PseudonymousDeveloperId = ValidDeveloperId,
        Window = new ContextInsightsWindow
        {
            Start = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero),
            End = new DateTimeOffset(2026, 6, 2, 8, 30, 0, TimeSpan.Zero),
        },
        Rows = rows.Length > 0 ? rows : [ValidRow()],
    };

    /// <summary>A clean batch as JSON (no extra fields).</summary>
    public const string ValidBatchJson = """
        {
          "schemaVersion": "1.0",
          "batchId": "ctx-batch-1",
          "generatedAt": "2026-06-02T09:15:00Z",
          "toolVersion": "0.1.19",
          "pseudonymousDeveloperId": "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3",
          "window": { "start": "2026-06-02T08:00:00Z", "end": "2026-06-02T08:30:00Z" },
          "rows": [
            {
              "rowKey": "ctx-row-1",
              "bucketStart": "2026-06-02T08:00:00Z",
              "bucketDurationSeconds": 1800,
              "repository": "https://github.com/turbinestudios/agent-observability",
              "contextFile": ".github/instructions/security.instructions.md",
              "category": "instruction",
              "appliedCount": 9,
              "skippedCount": 2,
              "skipReasonCounts": { "applyToNoMatch": 2 },
              "estTokensSum": 5400,
              "estTokensMax": 900,
              "sessionsWithErrorCount": 1,
              "sessionsWithDeviationCount": 1,
              "distinctSessionCount": 4,
              "lastActivityAtMs": 1780387740000
            }
          ]
        }
        """;

    /// <summary>
    /// The same batch but with a forbidden raw skip-reason field injected into a row. Proves the
    /// structural additionalProperties:false rejection keeps free-text reasons out of storage.
    /// </summary>
    public const string BatchJsonWithForbiddenField = """
        {
          "schemaVersion": "1.0",
          "batchId": "ctx-batch-1",
          "generatedAt": "2026-06-02T09:15:00Z",
          "toolVersion": "0.1.19",
          "pseudonymousDeveloperId": "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3",
          "window": { "start": "2026-06-02T08:00:00Z", "end": "2026-06-02T08:30:00Z" },
          "rows": [
            {
              "rowKey": "ctx-row-1",
              "bucketStart": "2026-06-02T08:00:00Z",
              "bucketDurationSeconds": 1800,
              "repository": "https://github.com/turbinestudios/agent-observability",
              "contextFile": ".github/instructions/security.instructions.md",
              "category": "instruction",
              "rawSkipReason": "applyTo glob /Users/jdoe/secret/** did not match",
              "appliedCount": 9,
              "skippedCount": 2,
              "estTokensSum": 5400,
              "estTokensMax": 900,
              "sessionsWithErrorCount": 1,
              "sessionsWithDeviationCount": 1,
              "distinctSessionCount": 4
            }
          ]
        }
        """;
}
