import { describe, it, expect } from 'vitest';
import { LocalDeviationDetector, DeviationConfig } from './localDeviations';
import { DeviationType, WorkflowConfig } from './models';
import { Interaction } from '../telemetry/models';

const REPO = 'https://github.com/example-org/sample-repo';

/** A fake config so this stays unit-testable without `vscode`. */
function fakeConfig(
  workflowConfigs: WorkflowConfig[],
  maxSessionMinutes = 60,
): DeviationConfig {
  return {
    getWorkflowConfigs: () => workflowConfigs,
    getMaxSessionMinutes: () => maxSessionMinutes,
  };
}

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

describe('LocalDeviationDetector default config', () => {
  it('flags a long turn (TimeoutExceeded) with the synthesized default workflow', () => {
    const detector = new LocalDeviationDetector(fakeConfig([], 60)); // 60-min window
    const base = 1_000_000;
    // One turn spanning 70 min > 60.
    const interactions = [
      interaction('coder', base, true),
      interaction('coder', base + 40 * 60_000, true),
      interaction('coder', base + 70 * 60_000, true),
    ];
    const result = detector.detectForSession(interactions, [base]);
    const timeouts = result.filter((d) => d.type === DeviationType.TimeoutExceeded);
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].workflowName).toBe('default');
    expect(timeouts[0].maxDurationMs).toBe(60 * 60_000);
  });

  it('does NOT flag a timeout when the same interactions split into short turns', () => {
    // The same 70-minute session, but as two user-request turns: each turn's own
    // duration stays under the window, and checks are scoped per turn.
    const detector = new LocalDeviationDetector(fakeConfig([], 60));
    const base = 1_000_000;
    const interactions = [
      interaction('coder', base, true),
      interaction('coder', base + 40 * 60_000, true),
      interaction('coder', base + 70 * 60_000, true),
    ];
    const result = detector.detectForSession(interactions, [base, base + 65 * 60_000]);
    expect(result.filter((d) => d.type === DeviationType.TimeoutExceeded)).toHaveLength(0);
  });

  it('flags a high-failure turn (ToolUsageAnomaly) with the default workflow', () => {
    const detector = new LocalDeviationDetector(fakeConfig([], 60));
    const base = 2_000_000;
    const interactions = [
      interaction('coder', base, false),
      interaction('coder', base + 1000, false),
      interaction('coder', base + 2000, true),
    ];
    const result = detector.detectForSession(interactions, [base]);
    const anomalies = result.filter((d) => d.type === DeviationType.ToolUsageAnomaly);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0].workflowName).toBe('default');
  });

  it('does NOT flag sequence/missing deviations under the default workflow', () => {
    // The default workflow has an empty expectedSequence and
    // sequenceDeviationAlert=false, so sequence/missing checks never fire.
    const detector = new LocalDeviationDetector(fakeConfig([], 60));
    const base = 3_000_000;
    const interactions = [
      interaction('coder', base, true),
      interaction('planner', base + 1000, true),
    ];
    const result = detector.detectForSession(interactions, [base]);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
    expect(result.filter((d) => d.type === DeviationType.MissingSteps)).toHaveLength(0);
  });

  it('returns no deviations for a clean, short, successful session', () => {
    const detector = new LocalDeviationDetector(fakeConfig([], 60));
    const base = 4_000_000;
    const interactions = [
      interaction('coder', base, true),
      interaction('coder', base + 60_000, true),
      interaction('coder', base + 120_000, true),
    ];
    expect(detector.detectForSession(interactions, [base])).toHaveLength(0);
  });

  it('returns no deviations for empty input', () => {
    const detector = new LocalDeviationDetector(fakeConfig([], 60));
    expect(detector.detectForSession([], [])).toHaveLength(0);
  });

  it('returns no deviations when the session has no user-request turns', () => {
    const detector = new LocalDeviationDetector(fakeConfig([], 60));
    const base = 5_000_000;
    const interactions = [
      interaction('coder', base, false),
      interaction('coder', base + 1000, false),
      interaction('coder', base + 2000, false),
    ];
    expect(detector.detectForSession(interactions, [])).toHaveLength(0);
  });
});

describe('LocalDeviationDetector explicit config', () => {
  it('activates sequence/missing checks only when an explicit config supplies an expectedSequence', () => {
    const explicit: WorkflowConfig = {
      repository: REPO,
      workflows: [
        {
          name: 'feature-development',
          expectedSequence: ['planner', 'coder', 'reviewer'],
          maxDurationMs: 30 * 60_000,
          sequenceDeviationAlert: true,
          timeoutExceededAlert: true,
          toolUsageAnomalyAlert: true,
        },
      ],
    };
    const detector = new LocalDeviationDetector(fakeConfig([explicit], 60));
    const base = 5_000_000;
    // planner+coder present, reviewer missing => MissingSteps.
    const interactions = [
      interaction('planner', base, true),
      interaction('coder', base + 1000, true),
    ];
    const result = detector.detectForSession(interactions, [base]);
    expect(result.some((d) => d.type === DeviationType.MissingSteps)).toBe(true);
  });

  it('matches the explicit config repository case-insensitively', () => {
    const explicit: WorkflowConfig = {
      repository: REPO.toUpperCase(),
      workflows: [
        {
          name: 'wf',
          expectedSequence: ['planner', 'coder', 'reviewer'],
          maxDurationMs: 30 * 60_000,
          sequenceDeviationAlert: true,
          timeoutExceededAlert: false,
          toolUsageAnomalyAlert: false,
        },
      ],
    };
    const detector = new LocalDeviationDetector(fakeConfig([explicit], 60));
    const base = 6_000_000;
    const interactions = [interaction('planner', base, true)];
    const result = detector.detectForSession(interactions, [base]);
    expect(result.some((d) => d.type === DeviationType.MissingSteps)).toBe(true);
  });

  it('excludes content-derived deviations (sync-eligible results only)', () => {
    // A step whose metadata matches but whose content predicate fails produces a
    // contentDerived MissingSteps on the per-turn path; the sync-adjacent
    // session flagging must never see it.
    const explicit: WorkflowConfig = {
      repository: REPO,
      workflows: [
        {
          name: 'no-secrets',
          expectedSequence: [],
          maxDurationMs: 30 * 60_000,
          sequenceDeviationAlert: true,
          timeoutExceededAlert: false,
          toolUsageAnomalyAlert: false,
          steps: [
            {
              name: 'no-secrets',
              predicate: { operation: 'chat' },
              contentPredicate: {
                attribute: 'copilot_chat.user_request',
                contains: 'AKIA',
                negate: true,
              },
            },
          ],
        },
      ],
    };
    const detector = new LocalDeviationDetector(fakeConfig([explicit], 60));
    const base = 7_000_000;
    const span: Interaction = { ...interaction('copilot', base, true), spanId: 'chat-1' };
    const lookup = (attr: string): ReadonlyMap<string, string> =>
      attr === 'copilot_chat.user_request'
        ? new Map([['chat-1', 'my key is AKIAIOSFODNN7EXAMPLE']])
        : new Map<string, string>();
    expect(detector.detectForSession([span], [base], lookup)).toHaveLength(0);
  });
});
