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
 * The check logic descends from a TypeScript port of the cloud dashboard's
 * `Services/WorkflowDeviationDetector.cs`, operating on the local
 * {@link Interaction} model:
 * - C# `AgentInteraction.Agent`     → {@link Interaction.agentName}
 * - C# `AgentInteraction.Timestamp` → {@link Interaction.timestampMs} (epoch ms)
 * - C# `AgentInteraction.Success`   → {@link Interaction.success}
 * - C# `AgentInteraction.Repository`→ {@link Interaction.repository}
 *
 * It supports a structured predicate DSL ({@link WorkflowDefinition.steps}
 * + {@link WorkflowDefinition.triggerPredicate}). When a workflow has `steps`,
 * predicate-based matching supersedes the legacy `expectedSequence` agent-name
 * subsequence logic; absent `steps`, the original path runs unchanged.
 *
 * ALL analysis is scoped to one user-request TURN ({@link detectForTurns}); the
 * old session-scoped path (which additionally FILTERED interactions by the
 * trigger) is gone. An optional {@link WorkflowDefinition.triggerPredicate} is a
 * pure applicability GATE: it decides whether a workflow applies to a turn and
 * never removes interactions from the analyzed set, so a trigger may be narrower
 * than — or disjoint from — the step predicates.
 *
 * Thresholds are preserved exactly: >50% failure over >=3 interactions =>
 * ToolUsageAnomaly; duration > maxDuration => TimeoutExceeded; in-order
 * subsequence match for sequence deviation; any missing expected step =>
 * MissingSteps. The detector is pure (no logging, no DB) so it can never emit
 * content.
 */
export class WorkflowDeviationDetector {
  /**
   * Per-TURN detection — the ONLY detection path.
   *
   * Each turn (one user request plus everything it spawned) is analyzed
   * independently against the configured workflows for its repository; results
   * are aligned BY INDEX to `turns`. There is no time-gap session grouping and
   * no synthesized default workflow — the caller supplies the turns and the
   * workflow configs. `triggerPredicate` gates applicability per turn (see
   * {@link analyzeTurn}).
   */
  detectForTurns(
    turns: readonly Interaction[][],
    configs: readonly WorkflowConfig[],
    contentLookup?: ContentLookup,
  ): WorkflowDeviation[][] {
    return turns.map((turn) => {
      if (turn.length === 0) {
        return [];
      }
      const config = configs.find((c) => equalsIgnoreCase(c.repository, turn[0].repository));
      if (config === undefined) {
        return [];
      }
      const deviations: WorkflowDeviation[] = [];
      for (const workflow of config.workflows) {
        for (const deviation of this.analyzeTurn(turn, workflow, config.repository, contentLookup)) {
          deviations.push(deviation);
        }
      }
      return deviations;
    });
  }

  /**
   * Per-TURN analysis.
   *
   * Here {@link WorkflowDefinition.triggerPredicate} is a pure applicability GATE:
   * the workflow applies to this turn iff at least one of the turn's interactions
   * matches it, and the trigger does NOT filter the analyzed set. Every check
   * then runs over the WHOLE turn, so a step may be satisfied by any interaction
   * in the task, in definition order, not necessarily adjacent to the trigger. A
   * turn the trigger does not match is not analyzed. The check ORDER (Sequence,
   * Timeout, Missing, ToolUsage) is preserved from the original C# port.
   */
  private analyzeTurn(
    turn: readonly Interaction[],
    workflow: WorkflowDefinition,
    repository: string,
    contentLookup: ContentLookup | undefined,
  ): WorkflowDeviation[] {
    if (!turnMatchesTrigger(turn, workflow, contentLookup)) {
      return [];
    }
    const deviations = runWorkflowChecks(turn, workflow, repository, contentLookup);
    // A workflow whose RELEVANCE depended on local-only content is itself
    // local-only: flag every resulting deviation so no sync/export path can carry it.
    if (workflow.triggerContentPredicate !== undefined) {
      return deviations.map((d) => ({ ...d, contentDerived: true }));
    }
    return deviations;
  }
}

/**
 * Whether a workflow's trigger applies to a turn on the per-turn path. The
 * metadata {@link WorkflowDefinition.triggerPredicate} (if any) must match some
 * interaction, AND the {@link WorkflowDefinition.triggerContentPredicate} (if any)
 * must match the turn's ANCHOR (earliest interaction — the user-request span)
 * content. A content gate that cannot be evaluated (no content lookup, or the
 * anchor carries no span id) is treated as NOT applicable: it fails CLOSED so a
 * content-scoped workflow never fires everywhere when content is unwired — the
 * mirror of the step content predicate's fail-OPEN inertness, which guards the
 * opposite false alarm.
 */
function turnMatchesTrigger(
  turn: readonly Interaction[],
  workflow: WorkflowDefinition,
  contentLookup: ContentLookup | undefined,
): boolean {
  const meta = workflow.triggerPredicate;
  if (meta !== undefined && !turn.some((i) => matchesPredicate(i, meta))) {
    return false;
  }
  const contentPredicate = workflow.triggerContentPredicate;
  if (contentPredicate !== undefined) {
    if (contentLookup === undefined || turn.length === 0) {
      return false;
    }
    const anchor = turn.reduce(
      (earliest, i) => (i.timestampMs < earliest.timestampMs ? i : earliest),
      turn[0],
    );
    const spanId = anchor.spanId;
    if (spanId === undefined || spanId.length === 0) {
      return false;
    }
    const value = contentLookup(contentPredicate.attribute).get(spanId) ?? '';
    if (!matchesContent(value, contentPredicate)) {
      return false;
    }
  }
  return true;
}

/**
 * Run the four workflow checks over the interactions of one turn already
 * determined to be IN SCOPE for the workflow ({@link WorkflowDeviationDetector}
 * `analyzeTurn` — `set` is always the WHOLE turn, never a trigger-filtered
 * subset). The set is time-ordered here so callers need not pre-sort.
 */
function runWorkflowChecks(
  set: readonly Interaction[],
  workflow: WorkflowDefinition,
  repository: string,
  contentLookup: ContentLookup | undefined,
): WorkflowDeviation[] {
  const ordered = [...set].sort((a, b) => a.timestampMs - b.timestampMs);
  const deviations: WorkflowDeviation[] = [];
  const now = Date.now();

  const steps = workflow.steps;
  const useSteps = steps !== undefined && steps.length > 0;
  const actualSequence = distinct(ordered.map((i) => i.agentName));
  const stepAnalyses = useSteps ? analyzeSteps(ordered, steps!, contentLookup) : undefined;

  // 1. Sequence deviation. The steps-path walk is METADATA-ONLY — ordering is a
  // property of the agent/operation sequence, not of content. A content
  // predicate failing on an otherwise in-order run is therefore NOT a reorder;
  // it surfaces solely as a content-derived MissingSteps below. This keeps a
  // SequenceDeviation purely metadata-derived (never `contentDerived`) and
  // avoids double-counting one content failure as both a reorder and a miss.
  if (workflow.sequenceDeviationAlert) {
    const deviation = useSteps
      ? checkStepSequence(ordered, steps!, stepAnalyses!, workflow, repository, now)
      : checkSequenceDeviation(actualSequence, workflow, repository, now);
    if (deviation !== undefined) {
      deviations.push(deviation);
    }
  }

  // 2. Timeout exceeded.
  if (workflow.timeoutExceededAlert) {
    const deviation = checkTimeoutExceeded(ordered, workflow, repository, now);
    if (deviation !== undefined) {
      deviations.push(deviation);
    }
  }

  // 3. Missing steps.
  if (workflow.sequenceDeviationAlert) {
    if (useSteps) {
      for (const deviation of checkStepMissing(
        ordered,
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
    const deviation = checkToolUsageAnomaly(ordered, workflow, repository, now);
    if (deviation !== undefined) {
      deviations.push(deviation);
    }
  }

  return deviations;
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
