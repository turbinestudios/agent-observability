/**
 * Workflow-deviation config and result shapes.
 *
 * A faithful TypeScript port of the cloud dashboard's
 * `Models/WorkflowConfig.cs`, `Models/WorkflowStep.cs` (unused here) and
 * `Models/WorkflowDeviation.cs`. The detector ({@link ./deviationDetector})
 * runs entirely on-machine over the local {@link ../telemetry/models.Interaction}
 * model, so no raw content is ever involved.
 *
 * Durations are expressed in milliseconds (the local model's native unit)
 * rather than the C# `TimeSpan`, but the thresholds are identical.
 */

/** Kinds of deviation the detector can emit. Mirrors C# `DeviationType`. */
export enum DeviationType {
  SequenceDeviation = 'SequenceDeviation',
  TimeoutExceeded = 'TimeoutExceeded',
  MissingSteps = 'MissingSteps',
  ToolUsageAnomaly = 'ToolUsageAnomaly',
}

/**
 * One expected workflow within a repository. Mirrors C# `WorkflowDefinition`,
 * with `MaxDuration` (a `TimeSpan`) expressed as `maxDurationMs`.
 */
export interface WorkflowDefinition {
  /** Human-readable workflow name (e.g. `feature-development`, `default`). */
  name: string;
  /** Expected ordered agent names. Empty disables sequence/missing checks. */
  expectedSequence: string[];
  /** Session duration / inter-interaction gap threshold, in milliseconds. */
  maxDurationMs: number;
  /** Emit a {@link DeviationType.SequenceDeviation} when the order is wrong. */
  sequenceDeviationAlert: boolean;
  /** Emit a {@link DeviationType.TimeoutExceeded} when the session runs long. */
  timeoutExceededAlert: boolean;
  /** Emit a {@link DeviationType.ToolUsageAnomaly} on a high failure rate. */
  toolUsageAnomalyAlert: boolean;
}

/** All expected workflows for one repository. Mirrors C# `WorkflowConfig`. */
export interface WorkflowConfig {
  /** Sanitized repository these workflows apply to. */
  repository: string;
  /** The workflows to check this repository's interactions against. */
  workflows: WorkflowDefinition[];
}

/** A detected deviation. Mirrors C# `WorkflowDeviation`. */
export interface WorkflowDeviation {
  /** Sanitized repository the deviation was found in. */
  repository: string;
  /** Name of the workflow whose rules flagged this. */
  workflowName: string;
  /** Which check fired. */
  type: DeviationType;
  /** Human-readable explanation (parity with the cloud description text). */
  description: string;
  /** When the deviation was detected (epoch ms). */
  detectedAt: number;
  /** Distinct actual agent sequence, when relevant. */
  actualSequence?: string[];
  /** Configured expected sequence, when relevant. */
  expectedSequence?: string[];
  /** Observed session duration in ms (TimeoutExceeded only). */
  actualDurationMs?: number;
  /** Configured maximum duration in ms (TimeoutExceeded only). */
  maxDurationMs?: number;
}
