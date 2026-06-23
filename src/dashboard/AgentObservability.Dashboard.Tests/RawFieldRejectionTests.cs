using System.Text.Json;
using AgentObservability.Dashboard.Models.Ingestion;
using AgentObservability.Dashboard.Services.Ingestion;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Proves the structural raw-field-rejection guarantee: any JSON property not declared on a DTO
/// (i.e. additionalProperties) makes deserialization throw, so a raw/sensitive column cannot ride
/// along into storage.
/// </summary>
public sealed class RawFieldRejectionTests
{
    private static readonly JsonSerializerOptions Options = IngestionEndpoints.DisallowOptions;

    [Fact]
    public void CleanBatch_RoundTrips()
    {
        var batch = JsonSerializer.Deserialize<AggregateBatch>(TestData.ValidBatchJson, Options);

        Assert.NotNull(batch);
        Assert.Equal("1.0", batch!.SchemaVersion);
        Assert.Single(batch.Buckets);
        Assert.Equal("chat", batch.Buckets[0].Operation);
    }

    [Fact]
    public void ForbiddenField_OnBucket_Throws()
    {
        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<AggregateBatch>(TestData.BatchJsonWithForbiddenField, Options));
    }

    [Fact]
    public void ExtraField_OnEnvelope_Throws()
    {
        const string json = """
            {
              "schemaVersion": "1.0",
              "batchId": "b1",
              "generatedAt": "2026-06-02T09:15:00Z",
              "toolVersion": "1.4.2",
              "pseudonymousDeveloperId": "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3",
              "orgId": "attacker-supplied-org",
              "window": { "start": "2026-06-02T08:00:00Z", "end": "2026-06-02T08:30:00Z" },
              "buckets": []
            }
            """;

        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<AggregateBatch>(json, Options));
    }

    [Fact]
    public void ExtraField_OnWindow_Throws()
    {
        const string json = """
            {
              "schemaVersion": "1.0",
              "batchId": "b1",
              "generatedAt": "2026-06-02T09:15:00Z",
              "toolVersion": "1.4.2",
              "pseudonymousDeveloperId": "dev_9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3",
              "window": { "start": "2026-06-02T08:00:00Z", "end": "2026-06-02T08:30:00Z", "tz": "UTC" },
              "buckets": []
            }
            """;

        Assert.Throws<JsonException>(() =>
            JsonSerializer.Deserialize<AggregateBatch>(json, Options));
    }
}
