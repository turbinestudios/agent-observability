import { Interaction } from '../telemetry/models';
import { ContentLookup, WorkflowDeviationDetector } from './deviationDetector';
import { WorkflowConfig, WorkflowDefinition, WorkflowDeviation } from './models';
import { groupInteractionsByTurn } from './turnGrouping';

/**
 * Minimal config surface {@link LocalDeviationDetector} needs, satisfied by the
 * extension's `Configuration`. Keeping it structural means this module is pure
 * logic and unit-testable without importing the `vscode`-coupled config.
 */
export interface DeviationConfig {
  /** Explicit per-repository workflows (`agentObservability.workflows`). */
  getWorkflowConfigs(): WorkflowConfig[];
  /** Default session window in minutes (`deviation.maxSessionMinutes`). */
  getMaxSessionMinutes(): number;
}

/**
 * Adapts the LOCAL session model to the per-turn {@link WorkflowDeviationDetector}.
 *
 * ALL detection is scoped to one user-request TURN — a workflow's
 * `triggerPredicate` only gates which turns it applies to; it never filters the
 * analyzed interactions.
 *
 * Configuration sources, in order of precedence per repository:
 * 1. An explicit {@link WorkflowConfig} from `agentObservability.workflows`.
 *    Only an explicit config may supply a non-empty `expectedSequence`, so
 *    sequence and missing-step checks activate ONLY when the user configures
 *    them.
 * 2. Otherwise ({@link detectForSession} only) a synthesized DEFAULT workflow per
 *    repository: empty `expectedSequence`, `maxDurationMs` from
 *    `deviation.maxSessionMinutes`, timeout + tool-usage-anomaly alerts on,
 *    sequence-deviation alert off.
 *
 * All detection runs on-machine; the detector is pure and content-free.
 */
export class LocalDeviationDetector {
  private readonly detector = new WorkflowDeviationDetector();

  constructor(private readonly config: DeviationConfig) {}

  /**
   * Detect SYNC-ELIGIBLE deviations across all of a session's turns (used by the
   * context-insights flagging in the sync path). The repository is taken from
   * the interactions themselves.
   *
   * Interactions are bucketed into the session's user-request turns
   * ({@link groupInteractionsByTurn}) and each turn is analyzed independently —
   * the same per-turn gate semantics as {@link detectForTurns} — then the turns'
   * deviations are flattened. Because the result feeds a cloud-adjacent signal
   * (which sessions get flagged for the context-insights upload), any deviation
   * marked {@link WorkflowDeviation.contentDerived} is EXCLUDED here: a flag
   * derived from raw local-only content must never influence what is uploaded.
   *
   * @param turnStartsMs ascending turn start timestamps (`SessionTurn.timestampMs`);
   *   an empty list means no user-request turns, so nothing is analyzed.
   * @param contentLookup optional LOCAL-ONLY span-content provider for workflows
   *   whose steps carry a content predicate. The raw text it returns is evaluated
   *   on-machine only and never enters a {@link WorkflowDeviation}. Absent →
   *   content predicates are inert.
   */
  detectForSession(
    interactions: readonly Interaction[],
    turnStartsMs: readonly number[],
    contentLookup?: ContentLookup,
  ): WorkflowDeviation[] {
    if (interactions.length === 0) {
      return [];
    }

    const repository = interactions[0].repository;
    const configs = this.config.getWorkflowConfigs();
    const explicit = configs.find(
      (c) => c.repository.toLowerCase() === repository.toLowerCase(),
    );

    const config: WorkflowConfig =
      explicit ?? {
        repository,
        workflows: [this.defaultWorkflow()],
      };

    const turns = groupInteractionsByTurn(interactions, turnStartsMs);
    return this.detector
      .detectForTurns(turns, [config], contentLookup)
      .flat()
      .filter((d) => d.contentDerived !== true);
  }

  /**
   * Detect per-TURN deviations for the LOCAL session-detail view + notifications.
   *
   * Each user-request turn is checked independently against the repository's
   * EXPLICITLY CONFIGURED workflows; results are aligned by index to `turns`.
   * Unlike {@link detectForSession} there is NO synthesized default workflow —
   * only configured workflows produce per-turn divergences, so a repository with
   * no `agentObservability.workflows` entry surfaces nothing. The
   * `triggerPredicate` gates which turns a workflow applies to (it no longer
   * filters the analyzed interactions).
   *
   * @param contentLookup optional LOCAL-ONLY span-content provider for content
   *   predicates (inert when absent), as in {@link detectForSession}.
   */
  detectForTurns(
    turns: readonly Interaction[][],
    contentLookup?: ContentLookup,
  ): WorkflowDeviation[][] {
    return this.detector.detectForTurns(turns, this.config.getWorkflowConfigs(), contentLookup);
  }

  /**
   * The synthesized default workflow. Empty `expectedSequence` keeps sequence
   * and missing-step checks inert (they require a configured sequence), while
   * the always-on timeout and failure-rate checks still apply — per turn, like
   * every other check.
   */
  private defaultWorkflow(): WorkflowDefinition {
    return {
      name: 'default',
      expectedSequence: [],
      maxDurationMs: this.config.getMaxSessionMinutes() * 60_000,
      sequenceDeviationAlert: false,
      timeoutExceededAlert: true,
      toolUsageAnomalyAlert: true,
    };
  }
}
