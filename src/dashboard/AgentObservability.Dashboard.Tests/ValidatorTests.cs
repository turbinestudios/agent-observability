using AgentObservability.Dashboard.Models.Ingestion;
using AgentObservability.Dashboard.Services.Ingestion;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

public sealed class ValidatorTests
{
    private readonly AggregateBatchValidator _validator = new();

    [Fact]
    public void ValidBatch_Passes()
    {
        var errors = _validator.Validate(TestData.ValidBatch());
        Assert.Empty(errors);
    }

    [Fact]
    public void EmptyBuckets_IsValidHeartbeat()
    {
        var batch = TestData.ValidBatch() with { Buckets = [] };
        var errors = _validator.Validate(batch);
        Assert.Empty(errors);
    }

    [Theory]
    [InlineData("dev_9F2C1AB47E0D3F5A8B6C2D1E4F70A9C3")] // uppercase hex not allowed
    [InlineData("dev_short")]
    [InlineData("user@example.com")]
    [InlineData("9f2c1ab47e0d3f5a8b6c2d1e4f70a9c3")] // missing prefix
    public void BadDeveloperId_ProducesError(string developerId)
    {
        var batch = TestData.ValidBatch() with { PseudonymousDeveloperId = developerId };
        var errors = _validator.Validate(batch);
        Assert.Contains(errors, e => e.Contains("pseudonymousDeveloperId"));
    }

    [Theory]
    [InlineData("https://x-access-token:ghp_secret@github.com/owner/repo")] // credential
    [InlineData("https://github.com/owner/repo?token=abc")] // query
    [InlineData("https://github.com/owner/repo#frag")] // fragment
    [InlineData("https://github.com/owner repo")] // whitespace
    public void RepositoryWithForbiddenChars_ProducesError(string repository)
    {
        var bucket = TestData.ValidBucket() with { Repository = repository };
        var batch = TestData.ValidBatch(bucket);
        var errors = _validator.Validate(batch);
        Assert.Contains(errors, e => e.Contains("repository"));
    }

    [Fact]
    public void UnknownRepositoryLiteral_IsAllowed()
    {
        var bucket = TestData.ValidBucket() with { Repository = "unknown" };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Empty(errors);
    }

    [Fact]
    public void BucketDurationNot1800_ProducesError()
    {
        var bucket = TestData.ValidBucket() with { BucketDurationSeconds = 900 };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("bucketDurationSeconds"));
    }

    [Theory]
    [InlineData("Chat")] // case-sensitive
    [InlineData("delete")]
    [InlineData("")]
    public void BadOperation_ProducesError(string operation)
    {
        var bucket = TestData.ValidBucket() with { Operation = operation };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("operation"));
    }

    [Fact]
    public void WrongHistogramLength_ProducesError()
    {
        var bucket = TestData.ValidBucket() with
        {
            LatencyHistogram = new LatencyHistogram
            {
                BoundsMs = TestData.CanonicalBoundsMs,
                Counts = [0, 1, 2], // wrong length (should be 9)
            },
        };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("counts"));
    }

    [Fact]
    public void WrongHistogramBounds_ProducesError()
    {
        var bucket = TestData.ValidBucket() with
        {
            LatencyHistogram = new LatencyHistogram
            {
                BoundsMs = [1, 2, 3, 4, 5, 6, 7, 8], // wrong bounds
                Counts = [0, 1, 2, 3, 4, 1, 1, 0, 0],
            },
        };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("boundsMs"));
    }

    [Fact]
    public void SuccessPlusErrorExceedsInteraction_ProducesError()
    {
        var bucket = TestData.ValidBucket() with
        {
            InteractionCount = 5,
            SuccessCount = 4,
            ErrorCount = 3, // 4 + 3 = 7 > 5
        };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("interactionCount"));
    }

    [Fact]
    public void NegativeMeasure_ProducesError()
    {
        var bucket = TestData.ValidBucket() with { InputTokens = -1 };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("inputTokens"));
    }

    [Fact]
    public void BadSchemaVersion_ProducesError()
    {
        var batch = TestData.ValidBatch() with { SchemaVersion = "2.0" };
        var errors = _validator.Validate(batch);
        Assert.Contains(errors, e => e.Contains("schemaVersion"));
    }

    [Fact]
    public void WindowEndNotAfterStart_ProducesError()
    {
        var start = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero);
        var batch = TestData.ValidBatch() with
        {
            Window = new AggregateWindow { Start = start, End = start },
        };
        var errors = _validator.Validate(batch);
        Assert.Contains(errors, e => e.Contains("window.end"));
    }

    // --- Server-side privacy guards: the server does NOT trust the client to have done the
    // schema-mandated normalization of free-text-ish fields. ---

    [Theory]
    [InlineData("PM")] // a real unmapped custom mode from the fixture — must be mapped to 'custom'
    [InlineData("Infrastructure")]
    [InlineData("my secret mode")]
    [InlineData("")]
    public void UnmappedAgentMode_ProducesError(string mode)
    {
        var bucket = TestData.ValidBucket() with { AgentMode = mode };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("agentMode"));
    }

    [Fact]
    public void CustomAgentMode_IsAllowed()
    {
        var bucket = TestData.ValidBucket() with { AgentMode = "custom" };
        Assert.Empty(_validator.Validate(TestData.ValidBatch(bucket)));
    }

    [Theory]
    [InlineData("read file")] // whitespace
    [InlineData("mcp:customer-acme/tool")] // path/colon could embed a customer identifier
    [InlineData("tool@host")]
    public void FreeTextToolName_ProducesError(string toolName)
    {
        var bucket = TestData.ValidBucket() with { Operation = "execute_tool", ToolName = toolName };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("toolName"));
    }

    [Theory]
    [InlineData("read_file")]
    [InlineData("runSubagent")]
    [InlineData("custom")]
    public void BuiltinOrCustomToolName_IsAllowed(string toolName)
    {
        var bucket = TestData.ValidBucket() with { Operation = "execute_tool", ToolName = toolName };
        Assert.Empty(_validator.Validate(TestData.ValidBatch(bucket)));
    }

    [Theory]
    [InlineData("feature/customer-acme secret")] // whitespace / free text
    [InlineData("branch@evil")]
    [InlineData("has?query")]
    public void UnsafeRepositoryBranch_ProducesError(string branch)
    {
        var bucket = TestData.ValidBucket() with { RepositoryBranch = branch };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("repositoryBranch"));
    }

    [Fact]
    public void SafeRepositoryBranch_IsAllowed()
    {
        var bucket = TestData.ValidBucket() with { RepositoryBranch = "feature/my-branch" };
        Assert.Empty(_validator.Validate(TestData.ValidBatch(bucket)));
    }

    [Theory]
    [InlineData("model with space")]
    [InlineData("model@host")]
    public void FreeTextModel_ProducesError(string model)
    {
        var bucket = TestData.ValidBucket() with { Model = model };
        var errors = _validator.Validate(TestData.ValidBatch(bucket));
        Assert.Contains(errors, e => e.Contains("model"));
    }

    [Theory]
    [InlineData("not-a-version")]
    [InlineData("1.2")]
    [InlineData("1.2.x")]
    public void NonSemverToolVersion_ProducesError(string version)
    {
        var batch = TestData.ValidBatch() with { ToolVersion = version };
        var errors = _validator.Validate(batch);
        Assert.Contains(errors, e => e.Contains("toolVersion"));
    }
}
