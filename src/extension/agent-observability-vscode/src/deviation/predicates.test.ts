import { describe, it, expect } from 'vitest';
import {
  ContentLookup,
  matchesPredicate,
  WorkflowDeviationDetector,
} from './deviationDetector';
import { DeviationType, WorkflowConfig, WorkflowDefinition, WorkflowStep } from './models';
import { Interaction } from '../telemetry/models';

/**
 * Tests for the structured predicate DSL (Phase 1 metadata + Phase 2 content).
 * The legacy agent-name `expectedSequence` path is covered by
 * `deviationDetector.test.ts`; these exercise `triggerPredicate`, `steps`, and
 * `contentPredicate` wiring (the latter via an injected, local-only lookup).
 */

const REPO = 'https://github.com/example-org/sample-repo';
const detector = new WorkflowDeviationDetector();

let counter = 0;
/** Build an Interaction; defaults are a successful agent-mode chat span. */
function mk(overrides: Partial<Interaction> = {}): Interaction {
  counter += 1;
  return {
    timestampMs: 1_000_000 + counter * 1000,
    sessionId: 'session',
    traceId: 'trace',
    spanId: `span-${counter}`,
    operation: 'chat',
    agentName: 'copilot',
    agentMode: 'agent',
    model: 'gpt-test',
    durationMs: 100,
    success: true,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    repository: REPO,
    ...overrides,
  };
}

/** A workflow with only the sequence/missing checks on, unless overridden. */
function wf(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'wf',
    expectedSequence: [],
    maxDurationMs: 45 * 60_000,
    sequenceDeviationAlert: true,
    timeoutExceededAlert: false,
    toolUsageAnomalyAlert: false,
    ...overrides,
  };
}

function cfg(def: WorkflowDefinition): WorkflowConfig {
  return { repository: REPO, workflows: [def] };
}

function step(name: string, predicate: WorkflowStep['predicate'], contentPredicate?: WorkflowStep['contentPredicate']): WorkflowStep {
  return contentPredicate === undefined ? { name, predicate } : { name, predicate, contentPredicate };
}

describe('matchesPredicate', () => {
  const base = mk({
    operation: 'execute_tool',
    agentName: 'coder',
    agentMode: 'agent',
    model: 'gpt-4o',
    toolName: 'edit_file',
    success: true,
  });

  it('matches when every present field matches (case-insensitive for strings)', () => {
    expect(
      matchesPredicate(base, {
        operation: 'EXECUTE_TOOL',
        agentName: 'Coder',
        agentMode: 'Agent',
        model: 'GPT-4O',
        toolName: 'EDIT_FILE',
        success: true,
      }),
    ).toBe(true);
  });

  it('matches on a partial predicate (absent fields match any value)', () => {
    expect(matchesPredicate(base, { toolName: 'edit_file' })).toBe(true);
    expect(matchesPredicate(base, { success: true })).toBe(true);
    expect(matchesPredicate(base, {})).toBe(true);
  });

  it('fails when any present field mismatches', () => {
    expect(matchesPredicate(base, { agentName: 'planner' })).toBe(false);
    expect(matchesPredicate(base, { operation: 'chat' })).toBe(false);
    expect(matchesPredicate(base, { success: false })).toBe(false);
    expect(matchesPredicate(base, { model: 'claude' })).toBe(false);
  });

  it('never matches a toolName predicate against an interaction with no tool', () => {
    const chat = mk({ operation: 'chat', toolName: undefined });
    expect(matchesPredicate(chat, { toolName: 'edit_file' })).toBe(false);
  });
});

describe('steps-based sequence + missing detection', () => {
  const steps: WorkflowStep[] = [
    step('plan', { agentName: 'planner' }),
    step('code', { agentName: 'coder' }),
    step('review', { agentName: 'reviewer' }),
  ];

  it('reports no deviation when steps match in order (extra interactions allowed)', () => {
    const interactions = [
      mk({ agentName: 'planner' }),
      mk({ agentName: 'helper' }),
      mk({ agentName: 'coder' }),
      mk({ agentName: 'reviewer' }),
    ];
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps }))]);
    expect(result).toHaveLength(0);
  });

  it('flags SequenceDeviation when steps occur out of order', () => {
    const interactions = [
      mk({ agentName: 'coder' }),
      mk({ agentName: 'planner' }),
      mk({ agentName: 'reviewer' }),
    ];
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps }))]);
    const seq = result.filter((d) => d.type === DeviationType.SequenceDeviation);
    expect(seq).toHaveLength(1);
    expect(seq[0].expectedSequence).toEqual(['plan', 'code', 'review']);
    expect(seq[0].actualSequence).toEqual(['coder', 'planner', 'reviewer']);
    expect(seq[0].contentDerived).toBeUndefined();
  });

  it('flags MissingSteps (not SequenceDeviation) when a step never appears', () => {
    const interactions = [mk({ agentName: 'planner' }), mk({ agentName: 'coder' })];
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps }))]);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
    const missing = result.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);
    expect(missing[0].description).toContain('review');
    expect(missing[0].contentDerived).toBeUndefined();
  });

  it('matches a step predicate on combined metadata fields (operation + tool + success)', () => {
    const combined: WorkflowStep[] = [
      step('edit-ok', { operation: 'execute_tool', toolName: 'edit_file', success: true }),
    ];
    const passing = [mk({ operation: 'execute_tool', toolName: 'edit_file', success: true })];
    expect(detector.detectDeviations(passing, [cfg(wf({ steps: combined }))])).toHaveLength(0);

    const failing = [mk({ operation: 'execute_tool', toolName: 'edit_file', success: false })];
    const result = detector.detectDeviations(failing, [cfg(wf({ steps: combined }))]);
    expect(result.filter((d) => d.type === DeviationType.MissingSteps)).toHaveLength(1);
  });

  it('treats a single agent repeated as incomplete (MissingSteps only, not a reorder)', () => {
    // Three planner interactions vs 3 distinct steps: in-order-but-incomplete.
    // 'code' and 'review' never appear, so it is a miss — not a reorder.
    const interactions = [
      mk({ agentName: 'planner' }),
      mk({ agentName: 'planner' }),
      mk({ agentName: 'planner' }),
    ];
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps }))]);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
    const missing = result.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);
    expect(missing[0].description).toContain('code');
    expect(missing[0].description).toContain('review');
  });

  it('flags a reorder for operation/tool-keyed steps even with a single constant agent', () => {
    // The common single-agent Copilot case: agentName is constant 'copilot' and
    // ordering is driven by operation/tool. All three phases occur, out of order.
    const opSteps: WorkflowStep[] = [
      step('chat', { operation: 'chat' }),
      step('edit', { operation: 'execute_tool', toolName: 'edit_file' }),
      step('test', { operation: 'execute_tool', toolName: 'run_tests' }),
    ];
    const interactions = [
      mk({ operation: 'execute_tool', toolName: 'edit_file' }),
      mk({ operation: 'chat' }),
      mk({ operation: 'execute_tool', toolName: 'run_tests' }),
    ];
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps: opSteps }))]);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(1);
    // Every step occurred, so nothing is missing.
    expect(result.filter((d) => d.type === DeviationType.MissingSteps)).toHaveLength(0);
  });

  it('does not flag a reorder for a missing operation-keyed step despite many distinct agents', () => {
    const opSteps: WorkflowStep[] = [
      step('chat', { operation: 'chat' }),
      step('edit', { operation: 'execute_tool', toolName: 'edit_file' }),
    ];
    // Three chats from DISTINCT agents; the edit step never occurs. The distinct
    // agents are irrelevant to the operation discriminator — this is a pure miss.
    const interactions = [
      mk({ agentName: 'alpha', operation: 'chat' }),
      mk({ agentName: 'beta', operation: 'chat' }),
      mk({ agentName: 'gamma', operation: 'chat' }),
    ];
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps: opSteps }))]);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
    const missing = result.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);
    expect(missing[0].description).toContain('edit');
  });
});

describe('triggerPredicate scoping', () => {
  const steps: WorkflowStep[] = [step('review', { agentName: 'reviewer' })];

  it('does not apply the workflow when the trigger matches nothing in the session', () => {
    // Trigger scopes to execute_tool, but the session is all chat → out of scope.
    const interactions = [mk({ agentName: 'planner', operation: 'chat' })];
    const result = detector.detectDeviations(interactions, [
      cfg(wf({ triggerPredicate: { operation: 'execute_tool' }, steps })),
    ]);
    expect(result).toHaveLength(0);
  });

  it('excludes out-of-scope interactions so an otherwise-present step is missing', () => {
    // reviewer ran, but in ask mode; the trigger scopes to agent mode only.
    const interactions = [
      mk({ agentName: 'planner', agentMode: 'agent' }),
      mk({ agentName: 'reviewer', agentMode: 'ask' }),
    ];
    const result = detector.detectDeviations(interactions, [
      cfg(wf({ triggerPredicate: { agentMode: 'agent' }, steps })),
    ]);
    const missing = result.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);
    expect(missing[0].description).toContain('review');
  });

  it('applies normally to the scoped subset when the trigger matches', () => {
    const interactions = [
      mk({ agentName: 'planner', agentMode: 'agent' }),
      mk({ agentName: 'reviewer', agentMode: 'agent' }),
    ];
    const result = detector.detectDeviations(interactions, [
      cfg(wf({ triggerPredicate: { agentMode: 'agent' }, steps })),
    ]);
    expect(result).toHaveLength(0);
  });
});

describe('content predicates (local-only, via injected lookup)', () => {
  /** Build a ContentLookup over a single attribute keyed by span id. */
  function lookupFor(attribute: string, bySpan: Record<string, string>): ContentLookup {
    return (attr) => (attr === attribute ? new Map(Object.entries(bySpan)) : new Map());
  }

  it('satisfies a step when content matches (contains)', () => {
    const it1 = mk({ operation: 'chat', spanId: 'chat-1' });
    const steps = [
      step('mentions-bug', { operation: 'chat' }, {
        attribute: 'copilot_chat.user_request',
        contains: 'fix the bug',
      }),
    ];
    const lookup = lookupFor('copilot_chat.user_request', { 'chat-1': 'Please fix the BUG now' });
    const result = detector.detectDeviations([it1], [cfg(wf({ steps }))], lookup);
    expect(result).toHaveLength(0);
  });

  it('flags a content-derived MissingSteps when metadata matches but content fails', () => {
    const it1 = mk({ operation: 'chat', spanId: 'chat-1' });
    const steps = [
      step('no-secrets', { operation: 'chat' }, {
        attribute: 'copilot_chat.user_request',
        contains: 'AKIA',
        negate: true,
      }),
    ];
    // user_request DOES contain a secret → negate makes the condition fail.
    const secret = 'my key is AKIAIOSFODNN7EXAMPLE and more';
    const lookup = lookupFor('copilot_chat.user_request', { 'chat-1': secret });
    const result = detector.detectDeviations([it1], [cfg(wf({ steps }))], lookup);

    const missing = result.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);
    expect(missing[0].contentDerived).toBe(true);
    expect(missing[0].description).toContain("no-secrets");
    expect(missing[0].description).toContain('content condition not met');
    // PRIVACY: the matched/raw text must never appear in the deviation.
    expect(missing[0].description).not.toContain('AKIA');
    expect(missing[0].description).not.toContain(secret);
    expect(missing[0].actualSequence).toBeUndefined();
    // A content failure is NOT a reorder: no SequenceDeviation is raised.
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
  });

  it('evaluates a regex content predicate (matches)', () => {
    const tool = mk({ operation: 'execute_tool', toolName: 'edit_file', spanId: 'tool-1' });
    const steps = [
      step('edits-ts', { operation: 'execute_tool', toolName: 'edit_file' }, {
        attribute: 'gen_ai.tool.call.arguments',
        matches: 'src/.*\\.ts$',
      }),
    ];
    const ok = lookupFor('gen_ai.tool.call.arguments', { 'tool-1': 'src/extension/foo.ts' });
    expect(detector.detectDeviations([tool], [cfg(wf({ steps }))], ok)).toHaveLength(0);

    const bad = lookupFor('gen_ai.tool.call.arguments', { 'tool-1': 'README.md' });
    const result = detector.detectDeviations([tool], [cfg(wf({ steps }))], bad);
    expect(result.filter((d) => d.type === DeviationType.MissingSteps)).toHaveLength(1);
  });

  it('treats content predicates as inert when no lookup is wired (metadata-only)', () => {
    const it1 = mk({ operation: 'chat', spanId: 'chat-1' });
    const steps = [
      step('mentions-bug', { operation: 'chat' }, {
        attribute: 'copilot_chat.user_request',
        contains: 'never-present',
      }),
    ];
    // No contentLookup passed → content is inert, so the step is satisfied on
    // metadata alone and no content-derived deviation appears.
    const result = detector.detectDeviations([it1], [cfg(wf({ steps }))]);
    expect(result).toHaveLength(0);
  });

  it('keeps a steps-path SequenceDeviation metadata-derived (never contentDerived), even with content steps', () => {
    const interactions = [
      mk({ agentName: 'coder', operation: 'chat', spanId: 's1' }),
      mk({ agentName: 'planner', operation: 'chat', spanId: 's2' }),
    ];
    const steps = [
      step('plan', { agentName: 'planner' }, {
        attribute: 'copilot_chat.user_request',
        contains: 'plan',
      }),
      step('code', { agentName: 'coder' }),
    ];
    // Both prompts satisfy plan's content predicate; the deviation is purely a
    // metadata reorder (coder before planner). The sequence walk is metadata-only,
    // so the deviation is NOT content-derived.
    const lookup = lookupFor('copilot_chat.user_request', { s1: 'please plan', s2: 'please plan' });
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps }))], lookup);
    const seq = result.filter((d) => d.type === DeviationType.SequenceDeviation);
    expect(seq).toHaveLength(1);
    expect(seq[0].contentDerived).toBeUndefined();
  });

  it('does not raise a SequenceDeviation when steps run in order but a content predicate fails', () => {
    // planner then coder — correct metadata order. plan's content predicate
    // requires 'plan' but the prompt lacks it: a content miss, not a reorder.
    const interactions = [
      mk({ agentName: 'planner', operation: 'chat', spanId: 's1' }),
      mk({ agentName: 'coder', operation: 'chat', spanId: 's2' }),
    ];
    const steps = [
      step('plan', { agentName: 'planner' }, {
        attribute: 'copilot_chat.user_request',
        contains: 'plan',
      }),
      step('code', { agentName: 'coder' }),
    ];
    const lookup = lookupFor('copilot_chat.user_request', { s1: 'do the thing', s2: 'write code' });
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps }))], lookup);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
    const missing = result.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);
    expect(missing[0].contentDerived).toBe(true);
    expect(missing[0].description).toContain('plan');
    expect(missing[0].description).toContain('content condition not met');
  });
});

describe('steps-path count-starvation guard (no phantom reorder)', () => {
  /** Build a ContentLookup over a single attribute keyed by span id. */
  function lookupFor(attribute: string, bySpan: Record<string, string>): ContentLookup {
    return (attr) => (attr === attribute ? new Map(Object.entries(bySpan)) : new Map());
  }

  it('does not flag a reorder for duplicate identical step predicates with one interaction', () => {
    // One event cannot satisfy two sequential identical steps — incomplete, not a reorder.
    const steps = [step('a1', { agentName: 'planner' }), step('a2', { agentName: 'planner' })];
    const result = detector.detectDeviations([mk({ agentName: 'planner' })], [cfg(wf({ steps }))]);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
  });

  it('does not flag a reorder for empty (match-any) step predicates with too few interactions', () => {
    const steps = [step('any1', {}), step('any2', {})];
    const result = detector.detectDeviations([mk({})], [cfg(wf({ steps }))]);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
  });

  it('does not flag a reorder when one span matches several overlapping step predicates', () => {
    const steps = [
      step('s-op', { operation: 'chat' }),
      step('s-agent', { agentName: 'copilot' }),
      step('s-model', { model: 'gpt-test' }),
    ];
    // A single span matches all three predicates; there is nothing to reorder.
    const result = detector.detectDeviations(
      [mk({ operation: 'chat', agentName: 'copilot', model: 'gpt-test' })],
      [cfg(wf({ steps }))],
    );
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
  });

  it('reports only the content miss (no phantom reorder) for a content-only step whose content fails', () => {
    const steps = [
      step('plan', { agentName: 'planner' }),
      step('code', { agentName: 'coder' }),
      step('gate', {}, { attribute: 'copilot_chat.user_request', contains: 'NOPE' }),
    ];
    const interactions = [
      mk({ agentName: 'planner', operation: 'chat', spanId: 's1' }),
      mk({ agentName: 'coder', operation: 'chat', spanId: 's2' }),
    ];
    const lookup = lookupFor('copilot_chat.user_request', { s1: 'aaa', s2: 'bbb' });
    const result = detector.detectDeviations(interactions, [cfg(wf({ steps }))], lookup);
    expect(result.filter((d) => d.type === DeviationType.SequenceDeviation)).toHaveLength(0);
    const missing = result.filter((d) => d.type === DeviationType.MissingSteps);
    expect(missing).toHaveLength(1);
    expect(missing[0].contentDerived).toBe(true);
    expect(missing[0].description).toContain('gate');
  });
});
