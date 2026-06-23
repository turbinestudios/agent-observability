using AgentObservability.Dashboard.Services;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace AgentObservability.Dashboard.Tests;

/// <summary>
/// Phase 9/10: privacy-first defaults. <see cref="WebUxOptions.ExposeRawSessionDetail"/> defaults to
/// false (raw detail hidden) and <see cref="AiQueryOptions.Enabled"/> defaults to true (assistant on).
/// Both can be flipped via configuration for rollback.
/// </summary>
public sealed class OptionsDefaultsTests
{
    [Fact]
    public void WebUxOptions_DefaultsToHidingRawSessionDetail()
    {
        var options = new WebUxOptions();
        Assert.False(options.ExposeRawSessionDetail);
    }

    [Fact]
    public void AiQueryOptions_DefaultsToEnabled()
    {
        var options = new AiQueryOptions();
        Assert.True(options.Enabled);
    }

    [Fact]
    public void WebUxOptions_BindsFromConfiguration()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [$"{WebUxOptions.SectionName}:ExposeRawSessionDetail"] = "true"
            })
            .Build();

        var options = config.GetSection(WebUxOptions.SectionName).Get<WebUxOptions>();

        Assert.NotNull(options);
        Assert.True(options!.ExposeRawSessionDetail);
    }

    [Fact]
    public void AiQueryOptions_BindsDisabledFromConfiguration()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                [$"{AiQueryOptions.SectionName}:Enabled"] = "false"
            })
            .Build();

        var options = config.GetSection(AiQueryOptions.SectionName).Get<AiQueryOptions>();

        Assert.NotNull(options);
        Assert.False(options!.Enabled);
    }

    [Fact]
    public void AiQueryOptions_DefaultsToEnabled_WhenSectionMissing()
    {
        var config = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>())
            .Build();

        // Empty section -> Get<T>() returns a fresh instance using the property default.
        var options = config.GetSection(AiQueryOptions.SectionName).Get<AiQueryOptions>() ?? new AiQueryOptions();

        Assert.True(options.Enabled);
    }
}
