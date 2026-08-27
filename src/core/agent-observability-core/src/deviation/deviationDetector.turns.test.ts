import { describe, it, expect } from 'vitest';
import { WorkflowDeviationDetector } from './deviationDetector';
import { DeviationType, WorkflowConfig } from './models';
import { Interaction } from '../telemetry/models';

const REPO = 'https://github.com/org/repo';

function ix(
  agentName: string,
  timestampMs: number,
  extra: Partial<Interaction> = {},
): Interaction {
  return {
    timestampMs,
    sessionId: 's',
    traceId: 't',
    operation: 'invoke_agent',
    agentName,
    agentMode: 'agent',
    model: 'm',
    durationMs: 1,
    success: true,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    repository: REPO,
    ...extra,
  };
}

/** A planner→coder workflow scoped by a trigger on the planner agent. */
const config: WorkflowConfig = {
  repository: REPO,
  workflows: [
    {
      name: 'feature',
      expectedSequence: [],
      maxDurationMs: 60 * 60_000,
      sequenceDeviationAlert: true,
      timeoutExceededAlert: false,
      toolUsageAnomalyAlert: false,
      triggerPredicate: { agentName: 'planner' },
      steps: [
        { name: 'Plan', predicate: { agentName: 'planner' } },
        { name: 'Implement', predicate: { agentName: 'coder' } },
      ],
    },
  ],
};

describe('detectForTurns — trigger gates, does not filter', () => {
  const detector = new WorkflowDeviationDetector();

  it('does NOT starve a later step whose agent differs from the trigger', () => {
    // Trigger is {agentName:'planner'}; the old scope-filtering model would drop
    // the coder interaction and falsely flag Implement missing. Per-turn, the
    // trigger only GATES — both steps are found in order over the whole turn.
    const turn = [ix('planner', 1000), ix('coder', 2000)];
    const [deviations] = detector.detectForTurns([turn], [config]);
    expect(deviations).toEqual([]);
  });

  it('finds steps as a non-contiguous ordered subsequence', () => {
    const turn = [ix('planner', 1000), ix('toolbot', 1500), ix('coder', 2000)];
    const [deviations] = detector.detectForTurns([turn], [config]);
    expect(deviations).toEqual([]);
  });

  it('flags MissingSteps when a relevant turn lacks a step', () => {
    const turn = [ix('planner', 1000)]; // coder never appears
    const [deviations] = detector.detectForTurns([turn], [config]);
    expect(deviations.some((d) => d.type === DeviationType.MissingSteps)).toBe(true);
  });

  it('flags SequenceDeviation when steps appear out of order', () => {
    const turn = [ix('coder', 1000), ix('planner', 2000)];
    const [deviations] = detector.detectForTurns([turn], [config]);
    expect(deviations.some((d) => d.type === DeviationType.SequenceDeviation)).toBe(true);
  });

  it('does not analyze a turn the trigger does not match', () => {
    const turn = [ix('coder', 1000), ix('reviewer', 2000)]; // no planner → not relevant
    const [deviations] = detector.detectForTurns([turn], [config]);
    expect(deviations).toEqual([]);
  });

  it('returns results aligned by index to the turns', () => {
    const clean = [ix('planner', 1000), ix('coder', 2000)];
    const diverged = [ix('planner', 1000)];
    const result = detector.detectForTurns([clean, diverged], [config]);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual([]);
    expect(result[1].some((d) => d.type === DeviationType.MissingSteps)).toBe(true);
  });

  it('returns no deviations when no workflow is configured for the repo', () => {
    const turn = [ix('planner', 1000), ix('coder', 2000)];
    const result = detector.detectForTurns([turn], []);
    expect(result).toEqual([[]]);
  });

  it('applies a trigger-less workflow to every turn', () => {
    const noTrigger: WorkflowConfig = {
      repository: REPO,
      workflows: [
        {
          name: 'always',
          expectedSequence: ['planner', 'coder', 'reviewer'],
          maxDurationMs: 60 * 60_000,
          sequenceDeviationAlert: true,
          timeoutExceededAlert: false,
          toolUsageAnomalyAlert: false,
        },
      ],
    };
    const turn = [ix('planner', 1000), ix('coder', 2000)]; // reviewer missing
    const [deviations] = detector.detectForTurns([turn], [noTrigger]);
    expect(deviations.some((d) => d.type === DeviationType.MissingSteps)).toBe(true);
  });
});

describe('detectForTurns — content-gated trigger (intent-based relevance)', () => {
  const detector = new WorkflowDeviationDetector();

  const contentConfig: WorkflowConfig = {
    repository: REPO,
    workflows: [
      {
        name: 'db-migration',
        expectedSequence: [],
        maxDurationMs: 60 * 60_000,
        sequenceDeviationAlert: true,
        timeoutExceededAlert: false,
        toolUsageAnomalyAlert: false,
        triggerContentPredicate: { attribute: 'copilot_chat.user_request', contains: 'migrate' },
        steps: [
          { name: 'Plan', predicate: { agentName: 'planner' } },
          { name: 'Implement', predicate: { agentName: 'coder' } },
        ],
      },
    ],
  };

  const lookupFor =
    (text: string) =>
    (attribute: string): ReadonlyMap<string, string> =>
      attribute === 'copilot_chat.user_request'
        ? new Map([['anchor', text]])
        : new Map<string, string>();

  it('applies only when the anchor request content matches', () => {
    const turn = [ix('planner', 1000, { spanId: 'anchor' })]; // coder missing
    const [deviations] = detector.detectForTurns(
      [turn],
      [contentConfig],
      lookupFor('please migrate the database'),
    );
    expect(deviations.some((d) => d.type === DeviationType.MissingSteps)).toBe(true);
  });

  it('does not apply when the request content does not match', () => {
    const turn = [ix('planner', 1000, { spanId: 'anchor' })];
    const [deviations] = detector.detectForTurns([turn], [contentConfig], lookupFor('fix a small typo'));
    expect(deviations).toEqual([]);
  });

  it('flags content-triggered divergences as contentDerived (local-only)', () => {
    const turn = [ix('planner', 1000, { spanId: 'anchor' })];
    const [deviations] = detector.detectForTurns([turn], [contentConfig], lookupFor('migrate the db'));
    expect(deviations.length).toBeGreaterThan(0);
    expect(deviations.every((d) => d.contentDerived === true)).toBe(true);
  });

  it('fails closed when content is unwired (no lookup) — never fires everywhere', () => {
    const turn = [ix('planner', 1000, { spanId: 'anchor' })];
    const [deviations] = detector.detectForTurns([turn], [contentConfig]);
    expect(deviations).toEqual([]);
  });
});
