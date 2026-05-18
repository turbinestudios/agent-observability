using System.Net.Http.Json;
using System.Text.Json;

using AgentObservability.Dashboard.Models;
using Microsoft.Extensions.Options;

namespace AgentObservability.Dashboard.Services;

/// <summary>
/// Background service that periodically checks for workflow deviations
/// and sends notifications when alerts are triggered.
/// </summary>
public sealed class AlertEngine : BackgroundService
{
    private readonly IServiceProvider _serviceProvider;
    private readonly WorkflowDeviationDetector _detector;
    private readonly AlertEngineOptions _options;
    private readonly ILogger<AlertEngine> _logger;
    private readonly IHttpClientFactory _httpClientFactory;

    // Track recently sent alerts to avoid duplicates within a cooldown period
    private readonly Dictionary<string, DateTimeOffset> _recentAlerts = new();
    private static readonly TimeSpan AlertCooldown = TimeSpan.FromMinutes(30);

    public AlertEngine(
        IServiceProvider serviceProvider,
        WorkflowDeviationDetector detector,
        IOptions<AlertEngineOptions> options,
        ILogger<AlertEngine> logger,
        IHttpClientFactory httpClientFactory)
    {
        _serviceProvider = serviceProvider;
        _detector = detector;
        _options = options.Value;
        _logger = logger;
        _httpClientFactory = httpClientFactory;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!_options.Enabled)
        {
            _logger.LogInformation("Alert engine is disabled");
            return;
        }

        _logger.LogInformation("Alert engine started. Polling every {Interval}, looking back {Window}",
            _options.PollingInterval, _options.LookbackWindow);

        // Wait a bit before first check to let the app stabilize
        await Task.Delay(TimeSpan.FromSeconds(30), stoppingToken);

        using var timer = new PeriodicTimer(_options.PollingInterval);

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await CheckForDeviationsAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (Exception ex)
            {
                _logger.LogError(ex, "Error during alert engine poll cycle");
            }

            await timer.WaitForNextTickAsync(stoppingToken);
        }

        _logger.LogInformation("Alert engine stopped");
    }

    private async Task CheckForDeviationsAsync(CancellationToken cancellationToken)
    {
        using var scope = _serviceProvider.CreateScope();
        var analyticsService = scope.ServiceProvider.GetRequiredService<LogAnalyticsService>();

        var interactions = await analyticsService.GetWorkflowInteractionsAsync(
            _options.LookbackWindow, cancellationToken);

        if (interactions.Count == 0)
        {
            _logger.LogDebug("No interactions found in lookback window");
            return;
        }

        // Use the configured workflow configs (currently static examples; in production load from storage)
        var configs = WorkflowConfig.Examples;

        var deviations = _detector.DetectDeviations(interactions, configs);

        if (deviations.Count == 0)
        {
            _logger.LogDebug("No deviations detected");
            return;
        }

        _logger.LogInformation("Detected {Count} workflow deviations", deviations.Count);

        foreach (var deviation in deviations)
        {
            await SendAlertIfNotCoolingDownAsync(deviation, cancellationToken);
        }

        PurgeExpiredCooldowns();
    }

    private async Task SendAlertIfNotCoolingDownAsync(WorkflowDeviation deviation, CancellationToken cancellationToken)
    {
        var alertKey = $"{deviation.Repository}:{deviation.WorkflowName}:{deviation.Type}";

        if (_recentAlerts.TryGetValue(alertKey, out var lastSent) &&
            DateTimeOffset.UtcNow - lastSent < AlertCooldown)
        {
            _logger.LogDebug("Alert {Key} is in cooldown, skipping", alertKey);
            return;
        }

        _recentAlerts[alertKey] = DateTimeOffset.UtcNow;

        _logger.LogWarning("Workflow deviation alert: [{Type}] {Repository}/{Workflow} — {Description}",
            deviation.Type, deviation.Repository, deviation.WorkflowName, deviation.Description);

        if (!string.IsNullOrWhiteSpace(_options.TeamsWebhookUrl))
        {
            await SendTeamsNotificationAsync(deviation, cancellationToken);
        }
    }

    private async Task SendTeamsNotificationAsync(WorkflowDeviation deviation, CancellationToken cancellationToken)
    {
        try
        {
            var client = _httpClientFactory.CreateClient("AlertEngine");

            var card = new
            {
                type = "message",
                attachments = new[]
                {
                    new
                    {
                        contentType = "application/vnd.microsoft.card.adaptive",
                        content = new
                        {
                            type = "AdaptiveCard",
                            version = "1.4",
                            body = new object[]
                            {
                                new { type = "TextBlock", text = "⚠️ Workflow Deviation Detected", weight = "Bolder", size = "Medium" },
                                new { type = "FactSet", facts = new object[]
                                {
                                    new { title = "Repository", value = deviation.Repository },
                                    new { title = "Workflow", value = deviation.WorkflowName },
                                    new { title = "Type", value = deviation.Type.ToString() },
                                    new { title = "Detected", value = deviation.DetectedAt.ToString("u") }
                                }},
                                new { type = "TextBlock", text = deviation.Description, wrap = true }
                            }
                        }
                    }
                }
            };

            var response = await client.PostAsJsonAsync(
                _options.TeamsWebhookUrl, card, cancellationToken);

            if (!response.IsSuccessStatusCode)
            {
                _logger.LogWarning("Teams notification failed with status {Status}", response.StatusCode);
            }
        }
        catch (Exception ex)
        {
            _logger.LogError(ex, "Failed to send Teams notification for {Repository}/{Workflow}",
                deviation.Repository, deviation.WorkflowName);
        }
    }

    private void PurgeExpiredCooldowns()
    {
        var expired = _recentAlerts
            .Where(kv => DateTimeOffset.UtcNow - kv.Value > AlertCooldown)
            .Select(kv => kv.Key)
            .ToList();

        foreach (var key in expired)
        {
            _recentAlerts.Remove(key);
        }
    }
}
