using AgentObservability.Dashboard.Models.Ingestion;
using AgentObservability.Dashboard.Services.Ingestion;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Server-side re-validation of the context-insights batch. The privacy-critical assertion is that
/// <c>contextFile</c> can only ever be a repo-relative, allowlisted customization path — an
/// absolute path, drive letter, traversal, backslash, or non-customization (source/doc) file is
/// rejected even though the client also enforces these rules.
/// </summary>
public sealed class ContextInsightsValidatorTests
{
    private static readonly ContextInsightsBatchValidator Validator = new();

    [Fact]
    public void ValidBatch_HasNoErrors()
    {
        var errors = Validator.Validate(ContextInsightsTestData.ValidBatch());
        Assert.Empty(errors);
    }

    [Theory]
    [InlineData("/etc/passwd.instructions.md")]            // leading slash (absolute)
    [InlineData("C:/Users/jdoe/x.instructions.md")]        // drive letter
    [InlineData(".github\\instructions\\x.instructions.md")] // backslash
    [InlineData("../../secrets/admin.instructions.md")]    // traversal
    [InlineData("a/../b.instructions.md")]                 // embedded traversal
    [InlineData(".github/prompts/évil.prompt.md")]         // non-ASCII / unsafe charset
    public void DangerousContextFilePath_IsRejected(string contextFile)
    {
        var batch = ContextInsightsTestData.ValidBatch(
            ContextInsightsTestData.ValidRow(contextFile: contextFile));

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("contextFile", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(".github/secrets.env")]   // not a customization suffix
    [InlineData("src/app.ts")]            // source file
    [InlineData("docs/onboarding.md")]    // plain doc, not allowlisted
    [InlineData("README.md")]             // not allowlisted
    public void NonAllowlistedContextFile_IsRejected(string contextFile)
    {
        var batch = ContextInsightsTestData.ValidBatch(
            ContextInsightsTestData.ValidRow(contextFile: contextFile));

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("contextFile", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData(".github/copilot-instructions.md", "instruction")]
    [InlineData(".github/instructions/security.instructions.md", "instruction")]
    [InlineData(".github/prompts/refactor.prompt.md", "prompt")]
    [InlineData(".agents/reviewer.agent.md", "agent")]
    [InlineData(".claude/skills/analyzer/SKILL.md", "skill")]
    [InlineData("AGENTS.md", "agent")]
    [InlineData("CLAUDE.md", "instruction")]
    public void AllowlistedContextFile_IsAccepted(string contextFile, string category)
    {
        var batch = ContextInsightsTestData.ValidBatch(
            ContextInsightsTestData.ValidRow(contextFile: contextFile, category: category));

        var errors = Validator.Validate(batch);

        Assert.Empty(errors);
    }

    [Fact]
    public void UnknownCategory_IsRejected()
    {
        var batch = ContextInsightsTestData.ValidBatch(
            ContextInsightsTestData.ValidRow(category: "source"));

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("category", StringComparison.Ordinal));
    }

    [Fact]
    public void RepositoryWithCredentials_IsRejected()
    {
        var row = ContextInsightsTestData.ValidRow() with
        {
            Repository = "https://jdoe:token@github.com/o/r",
        };
        var batch = ContextInsightsTestData.ValidBatch(row);

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("repository", StringComparison.Ordinal));
    }

    [Fact]
    public void BadDeveloperId_IsRejected()
    {
        var batch = ContextInsightsTestData.ValidBatch() with { PseudonymousDeveloperId = "jdoe@example.com" };

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("pseudonymousDeveloperId", StringComparison.Ordinal));
    }

    [Fact]
    public void WrongBucketDuration_IsRejected()
    {
        var batch = ContextInsightsTestData.ValidBatch(
            ContextInsightsTestData.ValidRow() with { BucketDurationSeconds = 60 });

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("bucketDurationSeconds", StringComparison.Ordinal));
    }

    [Fact]
    public void SkipReasonSumExceedingSkippedCount_IsRejected()
    {
        var row = ContextInsightsTestData.ValidRow() with
        {
            SkippedCount = 1,
            SkipReasonCounts = new SkipReasonCounts { ApplyToNoMatch = 2, Other = 3 },
        };
        var batch = ContextInsightsTestData.ValidBatch(row);

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("skipReasonCounts", StringComparison.Ordinal));
    }

    [Fact]
    public void WindowEndNotAfterStart_IsRejected()
    {
        var batch = ContextInsightsTestData.ValidBatch() with
        {
            Window = new ContextInsightsWindow
            {
                Start = new DateTimeOffset(2026, 6, 2, 8, 30, 0, TimeSpan.Zero),
                End = new DateTimeOffset(2026, 6, 2, 8, 0, 0, TimeSpan.Zero),
            },
        };

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("window", StringComparison.Ordinal));
    }

    [Fact]
    public void NegativeMeasure_IsRejected()
    {
        var batch = ContextInsightsTestData.ValidBatch(
            ContextInsightsTestData.ValidRow() with { AppliedCount = -1 });

        var errors = Validator.Validate(batch);

        Assert.Contains(errors, e => e.Contains("appliedCount", StringComparison.Ordinal));
    }
}
