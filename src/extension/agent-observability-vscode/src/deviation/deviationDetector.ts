import { Interaction } from '../telemetry/models';
import {
  DeviationType,
  WorkflowConfig,
  WorkflowDefinition,
  WorkflowDeviation,
} from './models';

/**
 * Detects deviations from expected multi-agent workflow patterns by comparing
 * actual agent interaction sequences against configured workflows.
 *
 * A faithful TypeScript port of the cloud dashboard's
 * `Services/WorkflowDeviationDetector.cs`, operating on the local
 * {@link Interaction} model:
 * - C# `AgentInteraction.Agent`     → {@link Interaction.agentName}
 * - C# `AgentInteraction.Timestamp` → {@link Interaction.timestampMs} (epoch ms)
 * - C# `AgentInteraction.Success`   → {@link Interaction.success}
 * - C# `AgentInteraction.Repository`→ {@link Interaction.repository}
 *
 * Thresholds are preserved exactly: >50% failure over >=3 interactions =>
 * ToolUsageAnomaly; duration > maxDuration => TimeoutExceeded; in-order
 * subsequence match for sequence deviation; any missing expected agent =>
 * MissingSteps. The detector is pure (no logging) so it can never emit content.
 */
export class WorkflowDeviationDetector {
  /**
   * Analyze interactions against all configured workflows and return any
   * deviations found. Mirrors C# `DetectDeviations`.
   */
  detectDeviations(
    interactions: readonly Interaction[],
    configs: readonly WorkflowConfig[],
  ): WorkflowDeviation[] {
    const deviations: WorkflowDeviation[] = [];

    for (const config of configs) {
      const repoInteractions = interactions
        .filter((i) => equalsIgnoreCase(i.repository, config.repository))
        .slice()
        .sort((a, b) => a.timestampMs - b.timestampMs);

      if (repoInteractions.length === 0) {
        continue;
      }

      for (const workflow of config.workflows) {
        const sessions = groupIntoSessions(repoInteractions, workflow.maxDurationMs);
        for (const session of sessions) {
          for (const deviation of this.analyzeSession(session, workflow, config.repository)) {
            deviations.push(deviation);
          }
        }
      }
    }

    return deviations;
  }

  /** Mirrors C# `AnalyzeSession`. */
  private analyzeSession(
    session: Interaction[],
    workflow: WorkflowDefinition,
    repository: string,
  ): WorkflowDeviation[] {
    const deviations: WorkflowDeviation[] = [];
    const actualSequence = distinct(session.map((i) => i.agentName));
    const now = Date.now();

    // Check sequence deviation.
    if (workflow.sequenceDeviationAlert) {
      const deviation = checkSequenceDeviation(actualSequence, workflow, repository, now);
      if (deviation !== undefined) {
        deviations.push(deviation);
      }
    }

    // Check timeout exceeded.
    if (workflow.timeoutExceededAlert) {
      const deviation = checkTimeoutExceeded(session, workflow, repository, now);
      if (deviation !== undefined) {
        deviations.push(deviation);
      }
    }

    // Check missing steps.
    if (workflow.sequenceDeviationAlert) {
      const deviation = checkMissingSteps(actualSequence, workflow, repository, now);
      if (deviation !== undefined) {
        deviations.push(deviation);
      }
    }

    // Check tool usage anomaly.
    if (workflow.toolUsageAnomalyAlert) {
      const deviation = checkToolUsageAnomaly(session, workflow, repository, now);
      if (deviation !== undefined) {
        deviations.push(deviation);
      }
    }

    return deviations;
  }
}

/** Mirrors C# `CheckSequenceDeviation`. */
function checkSequenceDeviation(
  actualSequence: string[],
  workflow: WorkflowDefinition,
  repository: string,
  detectedAt: number,
): WorkflowDeviation | undefined {
  // Check if the actual sequence matches the expected order (allowing extra agents).
  let expectedIndex = 0;
  for (const agent of actualSequence) {
    if (
      expectedIndex < workflow.expectedSequence.length &&
      equalsIgnoreCase(agent, workflow.expectedSequence[expectedIndex])
    ) {
      expectedIndex++;
    }
  }

  // If we didn't match all expected steps in order, it's a deviation.
  if (
    expectedIndex < workflow.expectedSequence.length &&
    actualSequence.length >= workflow.expectedSequence.length
  ) {
    return {
      repository,
      workflowName: workflow.name,
      type: DeviationType.SequenceDeviation,
      description: `Agent sequence deviated from expected order. Expected: [${workflow.expectedSequence.join(
        ' → ',
      )}], Actual: [${actualSequence.join(' → ')}]`,
      detectedAt,
      actualSequence,
      expectedSequence: workflow.expectedSequence,
    };
  }

  return undefined;
}

/** Mirrors C# `CheckTimeoutExceeded`. */
function checkTimeoutExceeded(
  session: Interaction[],
  workflow: WorkflowDefinition,
  repository: string,
  detectedAt: number,
): WorkflowDeviation | undefined {
  if (session.length < 2) {
    return undefined;
  }

  const sessionDurationMs = session[session.length - 1].timestampMs - session[0].timestampMs;

  if (sessionDurationMs > workflow.maxDurationMs) {
    const actualMinutes = sessionDurationMs / 60000;
    const maxMinutes = workflow.maxDurationMs / 60000;
    return {
      repository,
      workflowName: workflow.name,
      type: DeviationType.TimeoutExceeded,
      description: `Workflow duration (${actualMinutes.toFixed(1)} min) exceeded maximum (${Math.round(
        maxMinutes,
      )} min).`,
      detectedAt,
      actualDurationMs: sessionDurationMs,
      maxDurationMs: workflow.maxDurationMs,
    };
  }

  return undefined;
}

/** Mirrors C# `CheckMissingSteps`. */
function checkMissingSteps(
  actualSequence: string[],
  workflow: WorkflowDefinition,
  repository: string,
  detectedAt: number,
): WorkflowDeviation | undefined {
  const missingSteps = workflow.expectedSequence.filter(
    (expected) => !actualSequence.some((actual) => equalsIgnoreCase(actual, expected)),
  );

  if (missingSteps.length > 0 && actualSequence.length > 0) {
    return {
      repository,
      workflowName: workflow.name,
      type: DeviationType.MissingSteps,
      description: `Expected workflow steps were skipped: [${missingSteps.join(', ')}]`,
      detectedAt,
      actualSequence,
      expectedSequence: workflow.expectedSequence,
    };
  }

  return undefined;
}

/** Mirrors C# `CheckToolUsageAnomaly`. */
function checkToolUsageAnomaly(
  session: Interaction[],
  workflow: WorkflowDefinition,
  repository: string,
  detectedAt: number,
): WorkflowDeviation | undefined {
  // Detect anomaly: high error rate in session (> 50% failures).
  if (session.length < 3) {
    return undefined;
  }

  const failureRate = session.filter((i) => !i.success).length / session.length;

  if (failureRate > 0.5) {
    return {
      repository,
      workflowName: workflow.name,
      type: DeviationType.ToolUsageAnomaly,
      description: `High failure rate detected (${formatPercent(failureRate)}) across ${
        session.length
      } interactions in workflow session.`,
      detectedAt,
      actualSequence: distinct(session.map((i) => i.agentName)),
    };
  }

  return undefined;
}

/**
 * Group interactions into logical sessions. A new session starts when there's a
 * gap larger than `maxGapMs` between consecutive interactions. Mirrors C#
 * `GroupIntoSessions`. Input is assumed sorted ascending by timestamp.
 */
export function groupIntoSessions(
  interactions: readonly Interaction[],
  maxGapMs: number,
): Interaction[][] {
  const sessions: Interaction[][] = [];
  if (interactions.length === 0) {
    return sessions;
  }

  let currentSession: Interaction[] = [interactions[0]];

  for (let i = 1; i < interactions.length; i++) {
    const gap = interactions[i].timestampMs - interactions[i - 1].timestampMs;

    if (gap > maxGapMs) {
      sessions.push(currentSession);
      currentSession = [];
    }

    currentSession.push(interactions[i]);
  }

  if (currentSession.length > 0) {
    sessions.push(currentSession);
  }

  return sessions;
}

/** Case-insensitive ordinal string equality (C# StringComparison.OrdinalIgnoreCase). */
function equalsIgnoreCase(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Distinct preserving first-seen order (LINQ `Distinct()` semantics). */
function distinct(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/** Format a 0..1 ratio as an integer percent (C# "P0" => e.g. "67%"). */
function formatPercent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
