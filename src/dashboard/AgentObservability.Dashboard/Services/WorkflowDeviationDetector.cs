using AgentObservability.Dashboard.Models;

namespace AgentObservability.Dashboard.Services;

/// <summary>
/// Detects deviations from expected multi-agent workflow patterns
/// by comparing actual agent interaction sequences against configured workflows.
/// </summary>
public sealed class WorkflowDeviationDetector
{
    private readonly ILogger<WorkflowDeviationDetector> _logger;

    public WorkflowDeviationDetector(ILogger<WorkflowDeviationDetector> logger)
    {
        _logger = logger;
    }

    /// <summary>
    /// Analyzes recent interactions against all configured workflows and returns any deviations found.
    /// </summary>
    public IReadOnlyList<WorkflowDeviation> DetectDeviations(
        IReadOnlyList<AgentInteraction> interactions,
        IReadOnlyList<WorkflowConfig> configs)
    {
        var deviations = new List<WorkflowDeviation>();

        foreach (var config in configs)
        {
            var repoInteractions = interactions
                .Where(i => string.Equals(i.Repository, config.Repository, StringComparison.OrdinalIgnoreCase))
                .OrderBy(i => i.Timestamp)
                .ToList();

            if (repoInteractions.Count == 0)
            {
                continue;
            }

            foreach (var workflow in config.Workflows)
            {
                var sessions = GroupIntoSessions(repoInteractions, workflow.MaxDuration);

                foreach (var session in sessions)
                {
                    deviations.AddRange(AnalyzeSession(session, workflow, config.Repository));
                }
            }
        }

        _logger.LogDebug("Deviation detection complete: {Count} deviations found across {ConfigCount} configs",
            deviations.Count, configs.Count);

        return deviations;
    }

    private IReadOnlyList<WorkflowDeviation> AnalyzeSession(
        List<AgentInteraction> session,
        WorkflowDefinition workflow,
        string repository)
    {
        var deviations = new List<WorkflowDeviation>();
        var actualSequence = session.Select(i => i.Agent).Distinct().ToList();
        var now = DateTimeOffset.UtcNow;

        // Check sequence deviation
        if (workflow.SequenceDeviationAlert)
        {
            var deviation = CheckSequenceDeviation(actualSequence, workflow, repository, now);
            if (deviation is not null)
            {
                deviations.Add(deviation);
            }
        }

        // Check timeout exceeded
        if (workflow.TimeoutExceededAlert)
        {
            var deviation = CheckTimeoutExceeded(session, workflow, repository, now);
            if (deviation is not null)
            {
                deviations.Add(deviation);
            }
        }

        // Check missing steps
        if (workflow.SequenceDeviationAlert)
        {
            var deviation = CheckMissingSteps(actualSequence, workflow, repository, now);
            if (deviation is not null)
            {
                deviations.Add(deviation);
            }
        }

        // Check tool usage anomaly
        if (workflow.ToolUsageAnomalyAlert)
        {
            var deviation = CheckToolUsageAnomaly(session, workflow, repository, now);
            if (deviation is not null)
            {
                deviations.Add(deviation);
            }
        }

        return deviations;
    }

    private static WorkflowDeviation? CheckSequenceDeviation(
        List<string> actualSequence,
        WorkflowDefinition workflow,
        string repository,
        DateTimeOffset detectedAt)
    {
        // Check if the actual sequence matches the expected order (allowing extra agents)
        var expectedIndex = 0;
        foreach (var agent in actualSequence)
        {
            if (expectedIndex < workflow.ExpectedSequence.Count &&
                string.Equals(agent, workflow.ExpectedSequence[expectedIndex], StringComparison.OrdinalIgnoreCase))
            {
                expectedIndex++;
            }
        }

        // If we didn't match all expected steps in order, it's a deviation
        if (expectedIndex < workflow.ExpectedSequence.Count && actualSequence.Count >= workflow.ExpectedSequence.Count)
        {
            return new WorkflowDeviation
            {
                Repository = repository,
                WorkflowName = workflow.Name,
                Type = DeviationType.SequenceDeviation,
                Description = $"Agent sequence deviated from expected order. Expected: [{string.Join(" → ", workflow.ExpectedSequence)}], Actual: [{string.Join(" → ", actualSequence)}]",
                DetectedAt = detectedAt,
                ActualSequence = actualSequence,
                ExpectedSequence = workflow.ExpectedSequence
            };
        }

        return null;
    }

    private static WorkflowDeviation? CheckTimeoutExceeded(
        List<AgentInteraction> session,
        WorkflowDefinition workflow,
        string repository,
        DateTimeOffset detectedAt)
    {
        if (session.Count < 2)
        {
            return null;
        }

        var sessionDuration = session[^1].Timestamp - session[0].Timestamp;

        if (sessionDuration > workflow.MaxDuration)
        {
            return new WorkflowDeviation
            {
                Repository = repository,
                WorkflowName = workflow.Name,
                Type = DeviationType.TimeoutExceeded,
                Description = $"Workflow duration ({sessionDuration.TotalMinutes:N1} min) exceeded maximum ({workflow.MaxDuration.TotalMinutes:N0} min).",
                DetectedAt = detectedAt,
                ActualDuration = sessionDuration,
                MaxDuration = workflow.MaxDuration
            };
        }

        return null;
    }

    private static WorkflowDeviation? CheckMissingSteps(
        List<string> actualSequence,
        WorkflowDefinition workflow,
        string repository,
        DateTimeOffset detectedAt)
    {
        var missingSteps = workflow.ExpectedSequence
            .Where(expected => !actualSequence.Any(actual =>
                string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase)))
            .ToList();

        if (missingSteps.Count > 0 && actualSequence.Count > 0)
        {
            return new WorkflowDeviation
            {
                Repository = repository,
                WorkflowName = workflow.Name,
                Type = DeviationType.MissingSteps,
                Description = $"Expected workflow steps were skipped: [{string.Join(", ", missingSteps)}]",
                DetectedAt = detectedAt,
                ActualSequence = actualSequence,
                ExpectedSequence = workflow.ExpectedSequence
            };
        }

        return null;
    }

    private static WorkflowDeviation? CheckToolUsageAnomaly(
        List<AgentInteraction> session,
        WorkflowDefinition workflow,
        string repository,
        DateTimeOffset detectedAt)
    {
        // Detect anomaly: high error rate in session (> 50% failures)
        if (session.Count < 3)
        {
            return null;
        }

        var failureRate = (double)session.Count(i => !i.Success) / session.Count;

        if (failureRate > 0.5)
        {
            return new WorkflowDeviation
            {
                Repository = repository,
                WorkflowName = workflow.Name,
                Type = DeviationType.ToolUsageAnomaly,
                Description = $"High failure rate detected ({failureRate:P0}) across {session.Count} interactions in workflow session.",
                DetectedAt = detectedAt,
                ActualSequence = session.Select(i => i.Agent).Distinct().ToList()
            };
        }

        return null;
    }

    /// <summary>
    /// Groups interactions into logical sessions. A new session starts when
    /// there's a gap larger than maxDuration between consecutive interactions.
    /// </summary>
    private static List<List<AgentInteraction>> GroupIntoSessions(
        List<AgentInteraction> interactions,
        TimeSpan maxGap)
    {
        var sessions = new List<List<AgentInteraction>>();
        if (interactions.Count == 0)
        {
            return sessions;
        }

        var currentSession = new List<AgentInteraction> { interactions[0] };

        for (var i = 1; i < interactions.Count; i++)
        {
            var gap = interactions[i].Timestamp - interactions[i - 1].Timestamp;

            if (gap > maxGap)
            {
                sessions.Add(currentSession);
                currentSession = [];
            }

            currentSession.Add(interactions[i]);
        }

        if (currentSession.Count > 0)
        {
            sessions.Add(currentSession);
        }

        return sessions;
    }
}
