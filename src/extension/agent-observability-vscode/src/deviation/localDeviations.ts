import { Interaction } from '../telemetry/models';
import { ContentLookup, WorkflowDeviationDetector } from './deviationDetector';
import { WorkflowConfig, WorkflowDefinition, WorkflowDeviation } from './models';

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
 * Adapts the LOCAL session model to the ported {@link WorkflowDeviationDetector}.
 *
 * Configuration sources, in order of precedence per repository:
 * 1. An explicit {@link WorkflowConfig} from `agentObservability.workflows`.
 *    Only an explicit config may supply a non-empty `expectedSequence`, so
 *    sequence and missing-step checks activate ONLY when the user configures
 *    them.
 * 2. Otherwise a synthesized DEFAULT workflow per repository: empty
 *    `expectedSequence`, `maxDurationMs` from `deviation.maxSessionMinutes`,
 *    timeout + tool-usage-anomaly alerts on, sequence-deviation alert off.
 *
 * All detection runs on-machine; the detector is pure and content-free.
 */
export class LocalDeviationDetector {
  private readonly detector = new WorkflowDeviationDetector();

  constructor(private readonly config: DeviationConfig) {}

  /**
   * Detect deviations for a single session's interactions (used by the detail
   * panel). The repository is taken from the interactions themselves.
   *
   * @param contentLookup optional LOCAL-ONLY span-content provider, supplied by
   *   the panel for workflows whose steps carry a content predicate. The raw text
   *   it returns is evaluated on-machine only and never enters a
   *   {@link WorkflowDeviation}. Absent → content predicates are inert.
   */
  detectForSession(
    interactions: readonly Interaction[],
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

    return this.detector.detectDeviations(interactions, [config], contentLookup);
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
   * the always-on timeout and failure-rate checks still apply.
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
