import { Interaction } from '../telemetry/models';
import { matchesContent } from './contentMatcher';
import {
  ContentPredicate,
  DeviationType,
  StepPredicate,
  WorkflowConfig,
  WorkflowDefinition,
  WorkflowDeviation,
  WorkflowStep,
} from './models';

/**
 * Local-only span-content provider used by {@link ContentPredicate} evaluation:
 * maps an attribute key to a `Map<spanId, value>` for the interactions under
 * analysis (scoped to the session in the production path).
 *
 * The detector receives this as an opaque callback so it stays PURE and
 * content-free by construction — it never imports the database, and the raw text
 * it reads through the lookup is used only to compute a boolean (it is never
 * copied into a {@link WorkflowDeviation}). The DB-backed implementation lives in
 * the `vscode`-coupled panel/service layer. When the lookup is absent, content
 * predicates are inert (metadata-only matching), so the detector remains fully
 * unit-testable without any content wiring.
 */
export type ContentLookup = (attribute: string) => ReadonlyMap<string, string>;

/**
 * Detects deviations from expected multi-agent workflow patterns by comparing
 * actual agent interaction sequences against configured workflows.
 *
 * Originally a faithful TypeScript port of the cloud dashboard's
 * `Services/WorkflowDeviationDetector.cs`, operating on the local
 * {@link Interaction} model:
 * - C# `AgentInteraction.Agent`     → {@link Interaction.agentName}
 * - C# `AgentInteraction.Timestamp` → {@link Interaction.timestampMs} (epoch ms)
 * - C# `AgentInteraction.Success`   → {@link Interaction.success}
 * - C# `AgentInteraction.Repository`→ {@link Interaction.repository}
 *
 * It now also supports a structured predicate DSL ({@link WorkflowDefinition.steps}
 * + {@link WorkflowDefinition.triggerPredicate}). When a workflow has `steps`,
 * predicate-based matching supersedes the legacy `expectedSequence` agent-name
 * subsequence logic; absent `steps`, the original path runs unchanged. An
 * optional {@link WorkflowDefinition.triggerPredicate} scopes which interactions
 * are considered, and every check runs over that scoped subset.
 *
 * Thresholds are preserved exactly: >50% failure over >=3 interactions =>
 * ToolUsageAnomaly; duration > maxDuration => TimeoutExceeded; in-order
 * subsequence match for sequence deviation; any missing expected step =>
 * MissingSteps. The detector is pure (no logging, no DB) so it can never emit
 * content.
 */
export class WorkflowDeviationDetector {
  /**
   * Analyze interactions against all configured workflows and return any
   * deviations found. Mirrors C# `DetectDeviations`.
   *
   * @param contentLookup optional LOCAL-ONLY span-content provider; required only
   *   for steps that carry a {@link ContentPredicate}. Absent → content predicates
   *   are inert (metadata-only matching).
   */
  detectDeviations(
    interactions: readonly Interaction[],
    configs: readonly WorkflowConfig[],
    contentLookup?: ContentLookup,
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
          for (const deviation of this.analyzeSession(
            session,
            workflow,
            config.repository,
            contentLookup,
          )) {
            deviations.push(deviation);
          }
        }
      }
    }

    return deviations;
  }

  /**
   * Mirrors C# `AnalyzeSession`, generalized for the predicate DSL.
   *
   * A {@link WorkflowDefinition.triggerPredicate} (when present) scopes the
   * session to the matching interactions before any check runs; a workflow whose
   * trigger matches nothing in the session simply does not apply. The check
   * ORDER is preserved exactly (Sequence, Timeout, Missing, ToolUsage) for parity
   * with the C# port and the existing tests.
   */
  private analyzeSession(
    session: Interaction[],
    workflow: WorkflowDefinition,
    repository: string,
    contentLookup: ContentLookup | undefined,
  ): WorkflowDeviation[] {
    const deviations: WorkflowDeviation[] = [];
    const now = Date.now();

    const scoped =
      workflow.triggerPredicate !== undefined
        ? session.filter((i) => matchesPredicate(i, workflow.triggerPredicate!))
        : session;

    // A trigger that matches nothing means this workflow does not apply here.
    if (workflow.triggerPredicate !== undefined && scoped.length === 0) {
      return deviations;
    }

    const steps = workflow.steps;
    const useSteps = steps !== undefined && steps.length > 0;
    const actualSequence = distinct(scoped.map((i) => i.agentName));
    const stepAnalyses = useSteps ? analyzeSteps(scoped, steps!, contentLookup) : undefined;

    // 1. Sequence deviation. The steps-path walk is METADATA-ONLY — ordering is a
    // property of the agent/operation sequence, not of content. A content
    // predicate failing on an otherwise in-order run is therefore NOT a reorder;
    // it surfaces solely as a content-derived MissingSteps below. This keeps a
    // SequenceDeviation purely metadata-derived (never `contentDerived`) and
    // avoids double-counting one content failure as both a reorder and a miss.
    if (workflow.sequenceDeviationAlert) {
      const deviation = useSteps
        ? checkStepSequence(scoped, steps!, stepAnalyses!, workflow, repository, now)
        : checkSequenceDeviation(actualSequence, workflow, repository, now);
      if (deviation !== undefined) {
        deviations.push(deviation);
      }
    }

    // 2. Timeout exceeded.
    if (workflow.timeoutExceededAlert) {
      const deviation = checkTimeoutExceeded(scoped, workflow, repository, now);
      if (deviation !== undefined) {
        deviations.push(deviation);
      }
    }

    // 3. Missing steps.
    if (workflow.sequenceDeviationAlert) {
      if (useSteps) {
        for (const deviation of checkStepMissing(
          scoped,
          steps!,
          stepAnalyses!,
          workflow,
          repository,
          now,
        )) {
          deviations.push(deviation);
        }
      } else {
        const deviation = checkMissingSteps(actualSequence, workflow, repository, now);
        if (deviation !== undefined) {
          deviations.push(deviation);
        }
      }
    }

    // 4. Tool usage anomaly.
    if (workflow.toolUsageAnomalyAlert) {
      const deviation = checkToolUsageAnomaly(scoped, workflow, repository, now);
      if (deviation !== undefined) {
        deviations.push(deviation);
      }
    }

    return deviations;
  }
}

/**
 * Does an interaction satisfy a {@link StepPredicate}? Absent fields match any
 * value; string fields compare case-insensitively (OrdinalIgnoreCase parity);
 * `success` compares exactly. Exported for unit testing and reuse.
 */
export function matchesPredicate(interaction: Interaction, predicate: StepPredicate): boolean {
  if (predicate.operation !== undefined && !equalsIgnoreCase(interaction.operation, predicate.operation)) {
    return false;
  }
  if (predicate.agentName !== undefined && !equalsIgnoreCase(interaction.agentName, predicate.agentName)) {
    return false;
  }
  if (predicate.agentMode !== undefined && !equalsIgnoreCase(interaction.agentMode, predicate.agentMode)) {
    return false;
  }
  if (predicate.model !== undefined && !equalsIgnoreCase(interaction.model, predicate.model)) {
    return false;
  }
  if (predicate.toolName !== undefined) {
    if (interaction.toolName === undefined || !equalsIgnoreCase(interaction.toolName, predicate.toolName)) {
      return false;
    }
  }
  if (predicate.success !== undefined && interaction.success !== predicate.success) {
    return false;
  }
  return true;
}

/**
 * Evaluate a step's optional {@link ContentPredicate} for one interaction.
 *
 * Returns `true` when there is no content predicate, or when content matches.
 * When content is not wired (`contentLookup === undefined`) the predicate is
 * INERT (treated as a pass), so metadata-only contexts never produce spurious
 * content deviations. When the lookup is present but the interaction carries no
 * span id, the content cannot be correlated and the predicate fails. An absent
 * attribute resolves to the empty string (so e.g. a `negate` "must not contain"
 * passes when the attribute is missing).
 */
function stepContentMatches(
  interaction: Interaction,
  predicate: ContentPredicate | undefined,
  contentLookup: ContentLookup | undefined,
): boolean {
  if (predicate === undefined) {
    return true;
  }
  if (contentLookup === undefined) {
    return true;
  }
  const spanId = interaction.spanId;
  if (spanId === undefined || spanId.length === 0) {
    return false;
  }
  const value = contentLookup(predicate.attribute).get(spanId) ?? '';
  return matchesContent(value, predicate);
}

/** Per-step satisfaction over the scoped interactions. */
interface StepAnalysis {
  step: WorkflowStep;
  /** At least one scoped interaction matched the step's METADATA predicate. */
  metadataMatched: boolean;
  /** At least one scoped interaction fully matched (metadata AND content). */
  satisfied: boolean;
  /** Metadata matched somewhere but content never did (content-specific failure). */
  contentFailed: boolean;
}

/** Analyze each step against the scoped interactions. */
function analyzeSteps(
  scoped: Interaction[],
  steps: readonly WorkflowStep[],
  contentLookup: ContentLookup | undefined,
): StepAnalysis[] {
  return steps.map((step) => {
    let metadataMatches = 0;
    let fullMatches = 0;
    for (const interaction of scoped) {
      if (!matchesPredicate(interaction, step.predicate)) {
        continue;
      }
      metadataMatches++;
      if (stepContentMatches(interaction, step.contentPredicate, contentLookup)) {
        fullMatches++;
      }
    }
    return {
      step,
      metadataMatched: metadataMatches > 0,
      satisfied: fullMatches > 0,
      contentFailed:
        step.contentPredicate !== undefined && metadataMatches > 0 && fullMatches === 0,
    };
  });
}

/**
 * Predicate-based sequence check (steps path). Walks the scoped interactions in
 * time order, advancing through the steps when an interaction matches the current
 * step's METADATA predicate. Content predicates are deliberately NOT consulted
 * here (see {@link WorkflowDeviationDetector.analyzeSession}).
 *
 * A run is a REORDER exactly when every step matched SOMEWHERE (so every phase is
 * present) yet they could not all be matched in order. That is the precise signal
 * — a step that never matched is an absence (handled by {@link checkStepMissing}),
 * not a reorder, so it must not raise a SequenceDeviation. This deliberately does
 * NOT key off the distinct-agent count: steps commonly discriminate on
 * `operation`/`toolName`/`model` while a single agent (`copilot`) drives the whole
 * session, and an agent-count proxy would both miss real reorders and mislabel
 * pure misses.
 */
function checkStepSequence(
  scoped: Interaction[],
  steps: readonly WorkflowStep[],
  analyses: readonly StepAnalysis[],
  workflow: WorkflowDefinition,
  repository: string,
  detectedAt: number,
): WorkflowDeviation | undefined {
  let stepIndex = 0;
  for (const interaction of scoped) {
    if (stepIndex < steps.length && matchesPredicate(interaction, steps[stepIndex].predicate)) {
      stepIndex++;
    }
  }

  // Number of interactions that match SOME step's metadata. A reorder requires at
  // least as many of these as there are steps — otherwise an in-order threading
  // was numerically impossible (count starvation), so the run is incomplete, not
  // reordered. This guard (mirroring the legacy length check) is essential
  // because `metadataMatched` is per-step over the whole scope: one interaction
  // can mark several steps present (duplicate, empty/match-any, or overlapping
  // predicates), which would otherwise manufacture a phantom reorder.
  const matchingInteractionCount = scoped.filter((i) =>
    steps.some((s) => matchesPredicate(i, s.predicate)),
  ).length;
  const allStepsPresent = analyses.every((a) => a.metadataMatched);
  if (stepIndex < steps.length && allStepsPresent && matchingInteractionCount >= steps.length) {
    const actualSequence = distinct(scoped.map((i) => i.agentName));
    return {
      repository,
      workflowName: workflow.name,
      type: DeviationType.SequenceDeviation,
      description: `Agent workflow steps deviated from expected order. Expected: [${steps
        .map((s) => s.name)
        .join(' → ')}], Actual agents: [${actualSequence.join(' → ')}]`,
      detectedAt,
      actualSequence,
      expectedSequence: steps.map((s) => s.name),
    };
  }

  return undefined;
}

/**
 * Predicate-based missing-step check (steps path). Produces:
 * - one aggregate {@link DeviationType.MissingSteps} listing the steps whose
 *   METADATA never matched (a pure-metadata deviation), and
 * - one {@link DeviationType.MissingSteps} per step whose metadata matched but
 *   whose CONTENT predicate never did — flagged {@link WorkflowDeviation.contentDerived}
 *   with a description that names the step only (never the matched text).
 */
function checkStepMissing(
  scoped: Interaction[],
  steps: readonly WorkflowStep[],
  analyses: readonly StepAnalysis[],
  workflow: WorkflowDefinition,
  repository: string,
  detectedAt: number,
): WorkflowDeviation[] {
  const out: WorkflowDeviation[] = [];
  if (scoped.length === 0) {
    return out;
  }

  const metadataMissing = analyses
    .filter((a) => !a.satisfied && !a.contentFailed)
    .map((a) => a.step.name);
  if (metadataMissing.length > 0) {
    out.push({
      repository,
      workflowName: workflow.name,
      type: DeviationType.MissingSteps,
      description: `Expected workflow steps were skipped: [${metadataMissing.join(', ')}]`,
      detectedAt,
      actualSequence: distinct(scoped.map((i) => i.agentName)),
      expectedSequence: steps.map((s) => s.name),
    });
  }

  for (const analysis of analyses) {
    if (analysis.contentFailed) {
      out.push({
        repository,
        workflowName: workflow.name,
        type: DeviationType.MissingSteps,
        description: `Step '${analysis.step.name}' content condition not met.`,
        detectedAt,
        contentDerived: true,
      });
    }
  }

  return out;
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
