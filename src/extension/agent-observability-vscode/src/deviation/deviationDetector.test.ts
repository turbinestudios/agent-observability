import { describe, it, expect } from 'vitest';
import { WorkflowDeviationDetector } from './deviationDetector';
import { DeviationType, WorkflowConfig, WorkflowDefinition, WorkflowDeviation } from './models';
import { Interaction } from '../telemetry/models';

/**
 * Check-fidelity tests for the detector's four checks (descended from the C#
 * WorkflowDeviationDetector.cs port). Detection is per-TURN; each test analyzes
 * its interactions as ONE user-request turn. The thresholds mirror the C#
 * exactly:
 * - ToolUsageAnomaly: >=3 interactions AND failureRate > 0.5
 * - TimeoutExceeded: >=2 interactions AND duration > maxDuration
 * - SequenceDeviation: in-order subsequence not fully matched AND
 *   actual.length >= expected.length
 * - MissingSteps: any expected agent absent AND actual.length > 0
 */

const REPO = 'https://github.com/example-org/sample-repo';
const detector = new WorkflowDeviationDetector();

/** Analyze the interactions as a single user-request turn. */
function detect(
  interactions: readonly Interaction[],
  configs: readonly WorkflowConfig[],
): WorkflowDeviation[] {
  return detector.detectForTurns([[...interactions]], configs)[0];
}

/** Build a synthetic Interaction with only the fields the detector reads. */
function interaction(
  agentName: string,
  timestampMs: number,
  success: boolean,
  repository = REPO,
): Interaction {
  return {
    timestampMs,
    sessionId: 'session',
    traceId: 'trace',
    operation: 'chat',
    agentName,
    agentMode: 'agent',
    model: 'gpt-test',
    durationMs: 100,
    success,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    repository,
  };
}

/** A workflow with all checks enabled. */
function workflow(overrides: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'feature-development',
    expectedSequence: [],
    maxDurationMs: 30 * 60_000,
    sequenceDeviationAlert: true,
    timeoutExceededAlert: true,
    toolUsageAnomalyAlert: true,
    ...overrides,
  };
}

function config(def: WorkflowDefinition): WorkflowConfig {
  return { repository: REPO, workflows: [def] };
}

describe('WorkflowDeviationDetector port fidelity', () => {
  it('(a) flags ToolUsageAnomaly when >=3 interactions and >50% fail', () => {
    // 3 interactions, 2 failures => 66% > 50%. All within the max window so no
    // timeout. Sequence check disabled (no expectedSequence).
    const base = 1_000_000;
    const interactions = [
      interaction('coder', base, false),
      interaction('coder', base + 1000, false),
      interaction('coder', base + 2000, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ sequenceDeviationAlert: false }))],
    );
    const anomalies = result.filter((d) => d.type === DeviationType.ToolUsageAnomaly);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].repository).toBe(REPO);
    expect(anomalies[0].description).toContain('67%');
    expect(anomalies[0].description).toContain('3 interactions');
  });

  it('does NOT flag ToolUsageAnomaly at exactly 50% failure', () => {
    // 4 interactions, 2 failures => exactly 50%, not > 50%.
    const base = 2_000_000;
    const interactions = [
      interaction('coder', base, false),
      interaction('coder', base + 500, false),
      interaction('coder', base + 1000, true),
      interaction('coder', base + 1500, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ sequenceDeviationAlert: false }))],
    );
    expect(result.filter((d) => d.type === DeviationType.ToolUsageAnomaly)).toHaveLength(0);
  });

  it('does NOT flag ToolUsageAnomaly with fewer than 3 interactions', () => {
    const base = 3_000_000;
    const interactions = [
      interaction('coder', base, false),
      interaction('coder', base + 500, false),
    ];
    const result = detect(
      interactions,
      [config(workflow({ sequenceDeviationAlert: false }))],
    );
    expect(result.filter((d) => d.type === DeviationType.ToolUsageAnomaly)).toHaveLength(0);
  });

  it('(b) flags TimeoutExceeded when turn duration > maxDurationMs', () => {
    // maxDuration 30 min; three interactions spanning 31 min in one turn.
    const base = 4_000_000;
    const max = 30 * 60_000;
    const interactions = [
      interaction('coder', base, true),
      interaction('coder', base + 20 * 60_000, true),
      interaction('coder', base + 31 * 60_000, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ maxDurationMs: max, sequenceDeviationAlert: false }))],
    );
    const timeouts = result.filter((d) => d.type === DeviationType.TimeoutExceeded);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].actualDurationMs).toBe(31 * 60_000);
    expect(timeouts[0].maxDurationMs).toBe(max);
    expect(timeouts[0].description).toContain('31.0 min');
    expect(timeouts[0].description).toContain('30 min');
  });

  it('(c) flags SequenceDeviation when expected order not fully matched and actual.length >= expected.length', () => {
    // Expected [planner, coder, reviewer]; actual distinct [coder, planner,
    // reviewer] — only coder...reviewer match in order (expectedIndex=1 after,
    // matches coder? no: expected[0]=planner; coder!=planner; planner==... ).
    // Walk: expected[0]=planner. agents: coder(no), planner(yes->1),
    // reviewer(expected[1]=coder? no). expectedIndex stops at 1 < 3, and
    // actual.length(3) >= expected.length(3) => deviation.
    const base = 5_000_000;
    const interactions = [
      interaction('coder', base, true),
      interaction('planner', base + 1000, true),
      interaction('reviewer', base + 2000, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ expectedSequence: ['planner', 'coder', 'reviewer'] }))],
    );
    const seq = result.filter((d) => d.type === DeviationType.SequenceDeviation);
    expect(seq).toHaveLength(1);
    expect(seq[0].expectedSequence).toEqual(['planner', 'coder', 'reviewer']);
    expect(seq[0].actualSequence).toEqual(['coder', 'planner', 'reviewer']);
  });

  it('does NOT flag SequenceDeviation when the expected order is a subsequence', () => {
    // Expected [planner, coder]; actual [planner, coder, reviewer] matches in
    // order (extra agents allowed). All present => no MissingSteps either.
    const base = 6_000_000;
    const interactions = [
      interaction('planner', base, true),
      interaction('coder', base + 1000, true),
      interaction('reviewer', base + 2000, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ expectedSequence: ['planner', 'coder'] }))],
    );
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
    expect(result.filter((d) => d.type === DeviationType.MissingSteps)).toHaveLength(0);
  });

  it('(d) flags MissingSteps when an expected agent never appears', () => {
    // Expected [planner, coder, reviewer]; reviewer never runs.
    const base = 7_000_000;
    const interactions = [
      interaction('planner', base, true),
      interaction('coder', base + 1000, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ expectedSequence: ['planner', 'coder', 'reviewer'] }))],
    );
    const missing = result.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);
    expect(missing[0].description).toContain('reviewer');
  });

  it('(e) returns no deviations for a clean, in-order, short, mostly-successful session', () => {
    const base = 8_000_000;
    const interactions = [
      interaction('planner', base, true),
      interaction('coder', base + 60_000, true),
      interaction('reviewer', base + 120_000, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ expectedSequence: ['planner', 'coder', 'reviewer'] }))],
    );
    expect(result).toHaveLength(0);
  });

  it('matches the expected order case-insensitively (OrdinalIgnoreCase parity)', () => {
    const base = 9_000_000;
    const interactions = [
      interaction('Planner', base, true),
      interaction('CODER', base + 1000, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ expectedSequence: ['planner', 'coder'] }))],
    );
    expect(result).toHaveLength(0);
  });

  it('skips a turn whose repository has no configured workflows', () => {
    const base = 10_000_000;
    const interactions = [interaction('coder', base, true, 'https://github.com/other/repo')];
    const result = detect(interactions, [config(workflow())]);
    expect(result).toHaveLength(0);
  });

  it('emits multiple deviations in the original check order (Sequence, Timeout, Missing, ToolUsage)', () => {
    // One turn that trips three checks at once:
    // - distinct order [coder, planner, tester] vs expected [planner, coder,
    //   reviewer] with actual.length(3) >= expected.length(3) => SequenceDeviation
    // - 'reviewer' never appears => MissingSteps
    // - 2/3 failures (67% > 50%, count >= 3) => ToolUsageAnomaly
    // - timestamps 1s apart, maxDuration 30 min => NO TimeoutExceeded
    const base = 11_000_000;
    const interactions = [
      interaction('coder', base, false),
      interaction('planner', base + 1000, false),
      interaction('tester', base + 2000, true),
    ];
    const result = detect(
      interactions,
      [config(workflow({ expectedSequence: ['planner', 'coder', 'reviewer'] }))],
    );
    const types = result.map((d) => d.type);

    expect(types).toContain(DeviationType.SequenceDeviation);
    expect(types).toContain(DeviationType.MissingSteps);
    expect(types).toContain(DeviationType.ToolUsageAnomaly);
    expect(types).not.toContain(DeviationType.TimeoutExceeded);

    // C# AnalyzeSession emits in this order: Sequence, Timeout, Missing, ToolUsage.
    expect(types.indexOf(DeviationType.SequenceDeviation)).toBeLessThan(
      types.indexOf(DeviationType.MissingSteps),
    );
    expect(types.indexOf(DeviationType.MissingSteps)).toBeLessThan(
      types.indexOf(DeviationType.ToolUsageAnomaly),
    );
  });
});
