import { Interaction } from '../telemetry/models';
import { WorkflowDeviationDetector } from './deviationDetector';
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
   */
  detectForSession(interactions: readonly Interaction[]): WorkflowDeviation[] {
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

    return this.detector.detectDeviations(interactions, [config]);
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
